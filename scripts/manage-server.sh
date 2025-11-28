#!/bin/bash

# Lootbox Server Management Script
# Usage: ./manage-server.sh [start|stop|restart|status|logs|install|uninstall|monitor]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PLIST_FILE="$SCRIPT_DIR/lootbox-server.plist"
PLIST_NAME="com.lootbox.server"
LOG_DIR="$HOME/.lootbox-server-logs"
PORT=3456

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Ensure log directory exists
mkdir -p "$LOG_DIR"

function check_status() {
    # Check if launchd service is loaded
    if launchctl list | grep -q "$PLIST_NAME"; then
        echo -e "${GREEN}✓${NC} Lootbox service is loaded in launchd"
    else
        echo -e "${RED}✗${NC} Lootbox service is not loaded in launchd"
    fi

    # Check if server is responding
    if curl -s "http://localhost:$PORT/health" | grep -q '"status":"ok"'; then
        echo -e "${GREEN}✓${NC} Server is healthy on port $PORT"
    else
        echo -e "${RED}✗${NC} Server is not responding on port $PORT"
    fi

    # Check for processes
    PROCESS_COUNT=$(pgrep -f "lootbox" | wc -l | tr -d ' ')
    if [ "$PROCESS_COUNT" -gt 0 ]; then
        echo -e "${GREEN}✓${NC} Found $PROCESS_COUNT lootbox processes"
    else
        echo -e "${YELLOW}⚠${NC} No lootbox processes found"
    fi

    # Check for port conflicts
    if lsof -i :$PORT | grep -v "^COMMAND" | grep -v "bun" > /dev/null 2>&1; then
        echo -e "${YELLOW}⚠${NC} Other processes using port $PORT:"
        lsof -i :$PORT | grep -v "^COMMAND" | head -5
    fi
}

function start_server() {
    echo "Starting lootbox server..."

    # Kill conflicting processes
    echo "Checking for port conflicts..."
    if lsof -ti :$PORT > /dev/null 2>&1; then
        echo -e "${YELLOW}⚠${NC} Killing processes on port $PORT..."
        lsof -ti :$PORT | xargs kill -9 2>/dev/null
        sleep 2
    fi

    # Start via monitor script directly (not via launchd for now)
    cd "$PROJECT_DIR"
    nohup bun run src/lib/observability/server-monitor.ts > "$LOG_DIR/monitor.log" 2>&1 &
    echo $! > "$LOG_DIR/monitor.pid"

    sleep 3
    check_status
}

function stop_server() {
    echo "Stopping lootbox server..."

    # Stop monitor if running
    if [ -f "$LOG_DIR/monitor.pid" ]; then
        PID=$(cat "$LOG_DIR/monitor.pid")
        if kill -0 "$PID" 2>/dev/null; then
            echo "Stopping monitor (PID: $PID)..."
            kill -TERM "$PID"
            sleep 2
            rm "$LOG_DIR/monitor.pid"
        fi
    fi

    # Kill all lootbox processes
    echo "Killing all lootbox processes..."
    pkill -9 -f "lootbox" 2>/dev/null

    # Ensure port is free
    if lsof -ti :$PORT > /dev/null 2>&1; then
        echo "Freeing port $PORT..."
        lsof -ti :$PORT | xargs kill -9 2>/dev/null
    fi

    echo -e "${GREEN}✓${NC} Server stopped"
}

function restart_server() {
    stop_server
    sleep 2
    start_server
}

function show_logs() {
    LOG_FILE="$LOG_DIR/server-$(date +%Y-%m-%d).log"
    if [ -f "$LOG_FILE" ]; then
        echo "Showing last 50 lines of $LOG_FILE:"
        echo "----------------------------------------"
        tail -50 "$LOG_FILE"
    else
        echo "No log file found for today"
        echo "Available log files:"
        ls -la "$LOG_DIR"/*.log 2>/dev/null || echo "No log files found"
    fi
}

function install_service() {
    echo "Installing lootbox server as a launchd service..."

    # Copy plist to LaunchAgents
    cp "$PLIST_FILE" ~/Library/LaunchAgents/

    # Load the service
    launchctl load ~/Library/LaunchAgents/com.lootbox.server.plist

    echo -e "${GREEN}✓${NC} Service installed and started"
    echo "The server will now start automatically on login"
}

function uninstall_service() {
    echo "Uninstalling lootbox server launchd service..."

    # Unload the service
    launchctl unload ~/Library/LaunchAgents/com.lootbox.server.plist 2>/dev/null

    # Remove plist
    rm -f ~/Library/LaunchAgents/com.lootbox.server.plist

    echo -e "${GREEN}✓${NC} Service uninstalled"
}

function monitor_live() {
    echo "Monitoring lootbox server (Ctrl+C to exit)..."
    echo "----------------------------------------"

    # Start monitoring in foreground
    cd "$PROJECT_DIR"
    bun run src/lib/observability/server-monitor.ts
}

function show_help() {
    echo "Lootbox Server Management"
    echo "Usage: $0 [command]"
    echo ""
    echo "Commands:"
    echo "  start      - Start the server with monitoring"
    echo "  stop       - Stop the server and all processes"
    echo "  restart    - Restart the server"
    echo "  status     - Check server status"
    echo "  logs       - Show recent server logs"
    echo "  monitor    - Run monitor in foreground (for debugging)"
    echo "  install    - Install as launchd service (auto-start on login)"
    echo "  uninstall  - Uninstall launchd service"
    echo "  help       - Show this help message"
}

# Main command handling
case "$1" in
    start)
        start_server
        ;;
    stop)
        stop_server
        ;;
    restart)
        restart_server
        ;;
    status)
        check_status
        ;;
    logs)
        show_logs
        ;;
    monitor)
        monitor_live
        ;;
    install)
        install_service
        ;;
    uninstall)
        uninstall_service
        ;;
    help|--help|-h)
        show_help
        ;;
    *)
        show_help
        exit 1
        ;;
esac