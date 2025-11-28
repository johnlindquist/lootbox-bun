/**
 * ConnectionManager
 *
 * Manages WebSocket connections.
 * Handles:
 * - Client WebSocket lifecycle (connect, disconnect)
 * - Worker WebSocket lifecycle
 * - Broadcasting messages to all connected clients
 * - Welcome messages with available functions
 * - WebSocket handler creation for Hono routes
 * - Bun-native WebSocket handlers
 * - Connection limits (DoS protection)
 * - Periodic dead connection cleanup
 * - Rate limiting
 */

import type { MessageRouter } from "./message_router.ts";
import type { WorkerManager } from "../worker_manager.ts";
import type { ServerWebSocket } from "bun";

// Type for Hono WebSocket context
interface WebSocketContext {
  send(message: string): void;
  close(): void;
}

export interface WebSocketHandler {
  onOpen: (event: Event, ws: WebSocketContext) => void;
  onMessage: (event: MessageEvent, ws: WebSocketContext) => Promise<void>;
  onClose: (event: CloseEvent, ws: WebSocketContext) => void;
  onError: (evt: Event, ws: WebSocketContext) => void;
}

// Configuration
const MAX_CONNECTIONS = 100; // Maximum concurrent client connections
const MAX_MESSAGE_SIZE = 1024 * 1024; // 1MB max message size
const RATE_LIMIT_WINDOW_MS = 1000; // 1 second window
const RATE_LIMIT_MAX_MESSAGES = 50; // Max messages per window
const CLEANUP_INTERVAL_MS = 30000; // Cleanup dead connections every 30s

interface ClientInfo {
  ws: ServerWebSocket<unknown>;
  lastActivity: number;
  messageCount: number;
  windowStart: number;
}

export class ConnectionManager {
  private clients = new Set<WebSocketContext>();
  private bunClients = new Map<ServerWebSocket<unknown>, ClientInfo>();
  private bunWorkers = new Map<string, ServerWebSocket<unknown>>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Start periodic cleanup of dead connections
    this.startCleanup();
  }

  /**
   * Start periodic cleanup of dead/stale connections
   */
  private startCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      const staleThreshold = 60000; // 60 seconds without activity
      let removedCount = 0;

      for (const [ws, info] of this.bunClients) {
        // Check if connection is stale (no activity for 60s)
        if (now - info.lastActivity > staleThreshold) {
          try {
            // Try to ping - if this fails, connection is dead
            ws.send(JSON.stringify({ type: "ping" }));
            info.lastActivity = now; // Give it another chance
          } catch {
            // Connection is dead, remove it
            this.bunClients.delete(ws);
            removedCount++;
          }
        }
      }

      if (removedCount > 0) {
        console.error(`[ConnectionManager] Cleaned up ${removedCount} dead connections`);
      }
    }, CLEANUP_INTERVAL_MS);
  }

  /**
   * Stop cleanup interval
   */
  stopCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Check if rate limit is exceeded for a client
   */
  private checkRateLimit(info: ClientInfo): boolean {
    const now = Date.now();

    // Reset window if needed
    if (now - info.windowStart > RATE_LIMIT_WINDOW_MS) {
      info.windowStart = now;
      info.messageCount = 0;
    }

    info.messageCount++;
    return info.messageCount > RATE_LIMIT_MAX_MESSAGES;
  }

  /**
   * Add a client WebSocket connection
   */
  addClient(ws: WebSocketContext): void {
    this.clients.add(ws);
  }

  /**
   * Remove a client WebSocket connection
   */
  removeClient(ws: WebSocketContext): void {
    this.clients.delete(ws);
  }

  /**
   * Broadcast a message to all connected clients
   */
  broadcastToClients(message: object): void {
    const messageStr = JSON.stringify(message);
    // Broadcast to Hono WebSocket clients
    for (const client of this.clients) {
      try {
        client.send(messageStr);
      } catch (err) {
        console.error("Failed to send message to client:", err);
        this.clients.delete(client);
      }
    }
    // Broadcast to Bun native WebSocket clients
    for (const [ws] of this.bunClients) {
      try {
        ws.send(messageStr);
      } catch (err) {
        console.error("Failed to send message to bun client:", err);
        this.bunClients.delete(ws);
      }
    }
  }

  /**
   * Close all client connections
   */
  async closeAllClients(): Promise<void> {
    // Stop cleanup first
    this.stopCleanup();

    for (const client of this.clients) {
      try {
        client.close();
      } catch (err) {
        console.error("Error closing WebSocket connection:", err);
      }
    }
    this.clients.clear();

    for (const [ws] of this.bunClients) {
      try {
        ws.close();
      } catch (err) {
        console.error("Error closing bun WebSocket connection:", err);
      }
    }
    this.bunClients.clear();
  }

  /**
   * Send welcome message to a newly connected client
   */
  sendWelcome(ws: WebSocketContext, functions: string[]): void {
    ws.send(
      JSON.stringify({
        type: "welcome",
        functions,
      })
    );
  }

  /**
   * Get number of connected clients
   */
  getClientCount(): number {
    return this.clients.size + this.bunClients.size;
  }

  /**
   * Handle Bun WebSocket open event
   * Returns false if connection was rejected due to limits
   */
  handleWebSocketOpen(ws: ServerWebSocket<unknown>): boolean {
    // Check connection limit
    if (this.bunClients.size >= MAX_CONNECTIONS) {
      console.error(`[ConnectionManager] Connection limit reached (${MAX_CONNECTIONS}), rejecting new connection`);
      try {
        ws.send(JSON.stringify({ type: "error", error: "Server at connection limit, try again later" }));
        ws.close();
      } catch {
        // Best effort
      }
      return false;
    }

    // Add with tracking info
    const now = Date.now();
    this.bunClients.set(ws, {
      ws,
      lastActivity: now,
      messageCount: 0,
      windowStart: now,
    });
    return true;
  }

  /**
   * Handle Bun WebSocket message event
   */
  async handleWebSocketMessage(
    ws: ServerWebSocket<unknown>,
    message: string | Buffer,
    messageRouter: MessageRouter,
    availableFunctions: () => string[],
    workerManager: WorkerManager
  ): Promise<void> {
    const data = typeof message === "string" ? message : message.toString();

    // Check message size
    if (data.length > MAX_MESSAGE_SIZE) {
      console.error(`[ConnectionManager] Message too large (${data.length} bytes), rejecting`);
      ws.send(JSON.stringify({ type: "error", error: "Message too large" }));
      return;
    }

    // Check rate limit for client connections
    const clientInfo = this.bunClients.get(ws);
    if (clientInfo) {
      clientInfo.lastActivity = Date.now();
      if (this.checkRateLimit(clientInfo)) {
        console.error("[ConnectionManager] Rate limit exceeded, rejecting message");
        ws.send(JSON.stringify({ type: "error", error: "Rate limit exceeded, slow down" }));
        return;
      }
    }

    try {
      const parsed = JSON.parse(data);

      // Check if this is a worker identifying itself
      if (parsed.type === "identify" && parsed.workerId) {
        const workerId = parsed.workerId as string;
        // Move from clients to workers (use ws directly since Map key is the ws)
        this.bunClients.delete(ws);
        this.bunWorkers.set(workerId, ws);
        // Register the send callback for this worker
        workerManager.registerWorkerSender(workerId, (msg: string) => {
          ws.send(msg);
        });
        // Forward to worker manager
        workerManager.handleMessage(data);
        return;
      }

      // Check if this is a worker message
      if (this.bunWorkers.has(parsed.workerId)) {
        workerManager.handleMessage(data);
        return;
      }

      // If it's from a worker (ready, result, error, crash, progress messages)
      if (parsed.type === "ready" || parsed.type === "result" || parsed.type === "error" || parsed.type === "crash" || parsed.type === "progress") {
        workerManager.handleMessage(data);
        return;
      }

      // Otherwise treat as client message
      if (this.bunClients.has(ws)) {
        // Send welcome if this is the first message (client just connected)
        if (!parsed.method && !parsed.script) {
          ws.send(JSON.stringify({
            type: "welcome",
            functions: availableFunctions(),
          }));
          return;
        }

        // Route the message
        const response = await messageRouter.routeMessage(data, parsed.id);
        ws.send(JSON.stringify(response));
      }
    } catch (error) {
      console.error("Error handling WebSocket message:", error);
    }
  }

  /**
   * Handle Bun WebSocket close event
   */
  handleWebSocketClose(ws: ServerWebSocket<unknown>): void {
    // Remove from clients
    this.bunClients.delete(ws);

    // Check if it was a worker
    for (const [workerId, workerWs] of this.bunWorkers.entries()) {
      if (workerWs === ws) {
        this.bunWorkers.delete(workerId);
        break;
      }
    }
  }

  /**
   * Create WebSocket handler for worker connections
   */
  createWorkerWebSocketHandler(workerManager: WorkerManager): WebSocketHandler {
    let workerId: string | null = null;

    return {
      onOpen: (_event, _ws) => {
        // We'll set the workerId when we get the identify message
      },

      onMessage: async (event, ws) => {
        const data =
          typeof event.data === "string"
            ? event.data
            : new TextDecoder().decode(
                new Uint8Array(event.data as ArrayBuffer)
              );

        // Parse to get workerId from identify message
        try {
          const msg = JSON.parse(data);
          if (msg.type === "identify" && msg.workerId) {
            const id = msg.workerId as string;
            workerId = id;
            // Register the send callback for this worker
            workerManager.registerWorkerSender(id, (message: string) => {
              ws.send(message);
            });
          }
        } catch {
          // Ignore parse errors
        }

        // Forward all messages to worker manager
        workerManager.handleMessage(data);
      },

      onClose: () => {
        if (workerId) {
          workerManager.handleDisconnect(workerId);
        }
      },

      onError: (evt) => console.error("Worker WebSocket error:", evt),
    };
  }

  /**
   * Create WebSocket handler for client connections
   */
  createClientWebSocketHandler(
    messageRouter: MessageRouter,
    availableFunctions: () => string[]
  ): WebSocketHandler {
    return {
      onOpen: (_event, ws) => {
        console.error("WebSocket connected");
        this.addClient(ws);
        this.sendWelcome(ws, availableFunctions());
      },

      onMessage: async (event, ws) => {
        const data =
          typeof event.data === "string"
            ? event.data
            : new TextDecoder().decode(
                new Uint8Array(event.data as ArrayBuffer)
              );

        const parsed = JSON.parse(data);
        const response = await messageRouter.routeMessage(data, parsed.id);

        console.error("📤 Sending response back to client", {
          hasResult: !!response.result,
          hasError: !!response.error,
        });
        ws.send(JSON.stringify(response));
      },

      onClose: (_event, ws) => {
        console.error("WebSocket disconnected");
        this.removeClient(ws);
      },

      onError: (evt) => console.error("WebSocket error:", evt),
    };
  }
}
