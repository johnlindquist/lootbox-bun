/**
 * WebSocketRpcServer - Thin Orchestrator
 *
 * Composes and coordinates all manager classes to provide
 * a complete WebSocket RPC server.
 *
 * Responsibilities:
 * - Manager composition and initialization
 * - Lifecycle orchestration (start/stop)
 * - Wiring managers together with callbacks
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import type { Hono } from "hono";
import type { Ora } from "ora";
import { get_client, set_client } from "../client_cache.ts";
import type { McpConfigFile } from "../external-mcps/mcp_config.ts";
import { WorkerManager } from "./worker_manager.ts";
import { RpcCacheManager } from "./managers/rpc_cache_manager.ts";
import { FileWatcherManager } from "./managers/file_watcher_manager.ts";
import { TypeGeneratorManager } from "./managers/type_generator_manager.ts";
import { McpIntegrationManager } from "./managers/mcp_integration_manager.ts";
import { MessageRouter } from "./managers/message_router.ts";
import { ConnectionManager } from "./managers/connection_manager.ts";
import { OpenApiRouteHandler } from "./managers/openapi_route_handler.ts";
import { setupUIRoutes } from "../ui_server.ts";
import { showBootup } from "../lootbox-cli/bootup.ts";
import { getHealthMonitor } from "./managers/health_monitor.ts";

export class WebSocketRpcServer {
  private app = new OpenAPIHono();

  // Manager composition
  private rpcCacheManager: RpcCacheManager;
  private fileWatcherManager: FileWatcherManager;
  private typeGeneratorManager: TypeGeneratorManager;
  private mcpIntegrationManager: McpIntegrationManager;
  private connectionManager: ConnectionManager;
  private messageRouter!: MessageRouter; // Initialized in start()
  private workerManager: WorkerManager | null = null;

  private currentPort = 0;
  private server: ReturnType<typeof Bun.serve> | null = null;

  constructor() {
    // Initialize independent managers
    this.rpcCacheManager = new RpcCacheManager();
    this.fileWatcherManager = new FileWatcherManager();
    this.typeGeneratorManager = new TypeGeneratorManager(this.rpcCacheManager);
    this.mcpIntegrationManager = new McpIntegrationManager();
    this.connectionManager = new ConnectionManager();
  }

  /**
   * Wire managers together with event callbacks
   */
  private wireManagers(): void {
    // RPC cache refresh triggers:
    // 1. Type cache invalidation
    this.rpcCacheManager.onCacheRefreshed(() => {
      this.typeGeneratorManager.invalidateCache();
    });

    // 2. Client notifications
    this.rpcCacheManager.onCacheRefreshed((functions) => {
      this.connectionManager.broadcastToClients({
        type: "functions_updated",
        functions,
      });
    });

    // 3. Client code regeneration and caching
    this.rpcCacheManager.onCacheRefreshed(async () => {
      try {
        const schemas = this.mcpIntegrationManager.isEnabled()
          ? await this.mcpIntegrationManager.getSchemas()
          : undefined;
        const clientCode = await this.typeGeneratorManager.generateClientCode(
          this.currentPort,
          schemas
        );
        set_client(clientCode);
      } catch (err) {
        console.error("Failed to regenerate client code:", err);
      }
    });

    // 4. Worker restarts - REMOVED: Now handled by targeted restarts in file watcher
    // Old code restarted ALL workers on any change, causing CPU spikes
  }

  /**
   * Start the RPC server
   */
  async start(port: number, mcpConfig: McpConfigFile | null, spinner?: Ora): Promise<void> {
    this.currentPort = port;

    // Get config early
    const { get_config } = await import("../get_config.ts");
    const config = await get_config();

    // Phase 1 & 2: Load RPC cache and initialize MCP in parallel
    await Promise.all([
      this.rpcCacheManager.refreshCache(),
      mcpConfig ? this.mcpIntegrationManager.initialize(mcpConfig) : Promise.resolve(),
    ]);

    // Phase 2.5: Generate initial client code
    const schemas = this.mcpIntegrationManager.isEnabled()
      ? await this.mcpIntegrationManager.getSchemas()
      : undefined;
    const clientCode = await this.typeGeneratorManager.generateClientCode(
      port,
      schemas
    );
    set_client(clientCode);

    // Phase 3: Wire managers together
    this.wireManagers();

    // Phase 4: Setup message routing
    this.workerManager = new WorkerManager(port);
    this.messageRouter = new MessageRouter(
      this.workerManager,
      this.mcpIntegrationManager
    );

    // Set up progress callback to forward progress messages to clients
    // This enables long-running operations to send updates without timing out
    const connectionManager = this.connectionManager;
    this.workerManager.setProgressCallback((callId, message) => {
      // Broadcast progress to all clients - the client with the matching callId will handle it
      connectionManager.broadcastToClients({
        type: "progress",
        id: callId,
        message,
      });
    });

    // Phase 5: Setup HTTP routes with OpenAPI documentation
    this.setupRoutes();

    // Phase 7: Start file watcher with targeted worker restarts
    this.fileWatcherManager.startWatching(config.tools_dir, async (changedFiles) => {
      if (!this.workerManager) return;

      // 1. Capture state before refresh
      const previousFiles = this.rpcCacheManager.getUniqueFiles();

      // 2. Refresh cache (detects adds/removes)
      await this.rpcCacheManager.refreshCache();

      // 3. Get new state
      const currentFiles = this.rpcCacheManager.getUniqueFiles();

      // 4. Handle Removals (files in previous but not current)
      for (const [path, file] of previousFiles) {
        if (!currentFiles.has(path)) {
          console.error(`[Server] File removed: ${file.name}`);
          await this.workerManager.stopWorker(file.name);
        }
      }

      // 5. Handle Adds and Modifications
      for (const [path, file] of currentFiles) {
        const isNew = !previousFiles.has(path);
        const isModified = changedFiles.has(path);

        if (isNew) {
          console.error(`[Server] New file detected: ${file.name}`);
          await this.workerManager.startWorker(file);
        } else if (isModified) {
          console.error(`[Server] File modified: ${file.name}`);
          await this.workerManager.restartWorker(file.name, file);
        }
      }
    });

    // Phase 8: Start HTTP server using Bun
    const honoFetch = this.app.fetch.bind(this.app);
    const messageRouter = this.messageRouter;
    const rpcCacheManager = this.rpcCacheManager;
    const workerManager = this.workerManager!;

    this.server = Bun.serve({
      port,
      fetch(req, server) {
        // Check for WebSocket upgrade
        const url = new URL(req.url);
        if (url.pathname === "/ws" || url.pathname === "/worker-ws") {
          const upgraded = server.upgrade(req, {
            data: { path: url.pathname },
          });
          if (upgraded) {
            return undefined; // Return undefined for successful upgrade
          }
          return new Response("WebSocket upgrade failed", { status: 400 });
        }

        // Handle regular HTTP requests with Hono
        return honoFetch(req, server);
      },
      websocket: {
        // DEBUG: Testing WebSocket options to fix CPU spin
        idleTimeout: 0, // Disable idle timeout to prevent keep-alive polling
        perMessageDeflate: false, // Disable compression
        sendPings: false, // Disable automatic pings
        open(ws) {
          connectionManager.handleWebSocketOpen(ws);
        },
        message(ws, message) {
          connectionManager.handleWebSocketMessage(
            ws,
            message,
            messageRouter,
            () => rpcCacheManager.getFunctionNames(),
            workerManager
          );
        },
        close(ws) {
          connectionManager.handleWebSocketClose(ws);
        },
      },
    });

    // Give server time to start
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Phase 9: Initialize workers for all RPC files
    const uniqueFiles = this.rpcCacheManager.getUniqueFiles();
    for (const file of uniqueFiles.values()) {
      await this.workerManager!.startWorker(file);
    }
    console.error(`[Server] Started ${uniqueFiles.size} workers`);

    // Wait for workers to be ready
    await this.workerManager.waitForReady(5000);

    // Phase 10: Start health monitoring
    const healthMonitor = getHealthMonitor();
    healthMonitor.start();

    // Show bootup display
    showBootup({
      port,
      toolsDir: config.tools_dir,
      mcpServers: this.mcpIntegrationManager.getConnectedServers(),
      rpcFunctions: this.rpcCacheManager.getFunctionNames(),
      spinner,
    });
  }

  /**
   * Stop the RPC server
   */
  async stop(): Promise<void> {
    console.error("Stopping RPC server...");

    // Stop health monitoring
    getHealthMonitor().stop();

    // Stop workers
    if (this.workerManager) {
      await this.workerManager.stopAllWorkers();
      this.workerManager = null;
    }

    // Close all client connections
    await this.connectionManager.closeAllClients();

    // Shutdown MCP
    await this.mcpIntegrationManager.shutdown();

    // Stop file watcher
    this.fileWatcherManager.stopWatching();

    // Stop Bun server
    if (this.server) {
      this.server.stop();
      this.server = null;
    }

    console.error("RPC server stopped");
  }

  /**
   * Setup all HTTP and WebSocket routes
   */
  private setupRoutes(): void {
    // Setup OpenAPI-documented REST routes
    const openApiHandler = new OpenApiRouteHandler(
      this.app,
      this.rpcCacheManager,
      this.typeGeneratorManager,
      this.mcpIntegrationManager,
      get_client,
      this.currentPort
    );
    openApiHandler.setupRoutes();

    // Setup UI routes
    setupUIRoutes(this.app);

    // Setup WebSocket upgrade route
    this.app.get("/ws", (c) => {
      const upgradeHeader = c.req.header("Upgrade");
      if (upgradeHeader !== "websocket") {
        return c.text("Expected WebSocket upgrade", 426);
      }
      // Bun handles WebSocket upgrade via the websocket handler in Bun.serve
      return new Response(null, { status: 101 });
    });

    this.app.get("/worker-ws", (c) => {
      const upgradeHeader = c.req.header("Upgrade");
      if (upgradeHeader !== "websocket") {
        return c.text("Expected WebSocket upgrade", 426);
      }
      return new Response(null, { status: 101 });
    });
  }
}
