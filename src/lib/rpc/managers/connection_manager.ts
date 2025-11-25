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

export class ConnectionManager {
  private clients = new Set<WebSocketContext>();
  private bunClients = new Set<ServerWebSocket<unknown>>();
  private bunWorkers = new Map<string, ServerWebSocket<unknown>>();

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
    for (const client of this.clients) {
      try {
        client.send(messageStr);
      } catch (err) {
        console.error("Failed to send message to client:", err);
        this.clients.delete(client);
      }
    }
  }

  /**
   * Close all client connections
   */
  async closeAllClients(): Promise<void> {
    for (const client of this.clients) {
      try {
        client.close();
      } catch (err) {
        console.error("Error closing WebSocket connection:", err);
      }
    }
    this.clients.clear();
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
   */
  handleWebSocketOpen(ws: ServerWebSocket<unknown>): void {
    // Initially add to bunClients - will be moved to workers if it identifies as one
    this.bunClients.add(ws);
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

    try {
      const parsed = JSON.parse(data);

      // Check if this is a worker identifying itself
      if (parsed.type === "identify" && parsed.workerId) {
        const workerId = parsed.workerId as string;
        // Move from clients to workers
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

      // If it's from a worker (ready, result, error, crash messages)
      if (parsed.type === "ready" || parsed.type === "result" || parsed.type === "error" || parsed.type === "crash") {
        workerManager.handleMessage(data);
        return;
      }

      // Otherwise treat as client message
      if (this.bunClients.has(ws)) {
        // Send welcome if this is the first message (client just connected)
        if (!parsed.method) {
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
