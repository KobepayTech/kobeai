#!/bin/bash
# ============================================
# KOBEAI SYSTEM CONTROL
# ============================================

system_command() {
    case "$1" in
        start)   start_services ;;
        stop)    stop_services ;;
        restart) restart_services ;;
        status)  show_status ;;
        logs)    show_logs "$2" ;;
        *)
            echo -e "${RED}Unknown system command: $1${NC}"
            echo "Use: start, stop, restart, status, logs"
            return 1
            ;;
    esac
}

start_services() {
    echo -e "${CYAN}Starting KobeAI services...${NC}"
    cd "$KOBEAI_HOME"
    docker-compose up -d
    echo ""
    echo -e "${GREEN}Services started!${NC}"
    sleep 3
    show_status
}

stop_services() {
    echo -e "${YELLOW}Stopping KobeAI services...${NC}"
    cd "$KOBEAI_HOME"
    docker-compose down
    echo -e "${GREEN}Services stopped!${NC}"
}

restart_services() {
    echo -e "${CYAN}Restarting KobeAI services...${NC}"
    cd "$KOBEAI_HOME"
    docker-compose restart
    echo -e "${GREEN}Services restarted!${NC}"
    sleep 3
    show_status
}

show_status() {
    echo -e "${BOLD}${CYAN}KobeAI Service Status:${NC}"
    echo ""
    cd "$KOBEAI_HOME"
    printf "%-20s %-15s %-10s %s\n" "SERVICE" "STATUS" "PORT" "HEALTH"
    echo "----------------------------------------------------------------"
    check_service "postgres" "kobeai-postgres" "5432" "docker exec kobeai-postgres pg_isready -U kobeai &>/dev/null"
    check_service "redis"    "kobeai-redis"    "6379" "docker exec kobeai-redis redis-cli ping &>/dev/null"
    check_service "ollama"   "kobeai-ollama"   "11434" "curl -s http://localhost:11434/api/tags &>/dev/null"
    check_service "backend"  "kobeai-backend"  "8000" "curl -s http://localhost:8000/health &>/dev/null"
    check_service "teacher"  "kobeai-teacher"  "3000" "curl -s http://localhost:3000 &>/dev/null"
    check_service "parent"   "kobeai-parent"   "5173" "curl -s http://localhost:5173 &>/dev/null"
    check_service "nginx"    "kobeai-nginx"    "80"   "curl -s http://localhost/health &>/dev/null"
    echo ""
}

check_service() {
    local name="$1"
    local container="$2"
    local port="$3"
    local health_cmd="$4"

    if docker ps | grep -q "$container"; then
        if eval "$health_cmd"; then
            printf "%-20s ${GREEN}%-15s${NC} %-10s ${GREEN}%s${NC}\n" "$name" "RUNNING" "$port" "HEALTHY"
        else
            printf "%-20s ${YELLOW}%-15s${NC} %-10s ${YELLOW}%s${NC}\n" "$name" "RUNNING" "$port" "UNHEALTHY"
        fi
    else
        printf "%-20s ${RED}%-15s${NC} %-10s ${RED}%s${NC}\n" "$name" "STOPPED" "$port" "-"
    fi
}

health_check() {
    echo -e "${BOLD}${GREEN}KobeAI Full Health Check${NC}"
    echo "==============================================================="
    echo ""
    local all_healthy=true

    echo -e "${CYAN}API Server:${NC}"
    if curl -s http://localhost:8000/health | grep -q "healthy"; then
        echo -e "  ${GREEN}API is healthy${NC}"
        curl -s http://localhost:8000/health | jq . 2>/dev/null || echo "  $(curl -s http://localhost:8000/health)"
    else
        echo -e "  ${RED}API is not responding${NC}"
        all_healthy=false
    fi

    echo ""
    echo -e "${CYAN}Database:${NC}"
    if docker exec kobeai-postgres pg_isready -U kobeai &>/dev/null; then
        local db_size=$(docker exec kobeai-postgres psql -U kobeai -d kobeai -c "SELECT pg_database_size('kobeai')/1024/1024 as size_mb;" -t | xargs)
        echo -e "  ${GREEN}PostgreSQL is ready${NC}"
        echo -e "  Database size: ${db_size} MB"
    else
        echo -e "  ${RED}PostgreSQL is not responding${NC}"
        all_healthy=false
    fi

    echo ""
    echo -e "${CYAN}Redis Cache:${NC}"
    if docker exec kobeai-redis redis-cli ping &>/dev/null; then
        local redis_memory=$(docker exec kobeai-redis redis-cli INFO memory | grep used_memory_human | cut -d: -f2 | xargs)
        echo -e "  ${GREEN}Redis is ready${NC}"
        echo -e "  Memory used: $redis_memory"
    else
        echo -e "  ${RED}Redis is not responding${NC}"
        all_healthy=false
    fi

    echo ""
    echo -e "${CYAN}AI Models:${NC}"
    if curl -s http://localhost:11434/api/tags &>/dev/null; then
        local model_count=$(curl -s http://localhost:11434/api/tags | jq '.models | length' 2>/dev/null || echo "0")
        echo -e "  ${GREEN}Ollama is ready${NC}"
        echo -e "  Models installed: $model_count"
        curl -s http://localhost:11434/api/tags | jq -r '.models[] | "  - \(.name)"' 2>/dev/null
    else
        echo -e "  ${RED}Ollama is not responding${NC}"
        all_healthy=false
    fi

    echo ""
    echo -e "${CYAN}Teacher Dashboard:${NC}"
    if curl -s -o /dev/null -w "%{http_code}" http://localhost:3000 | grep -q "200"; then
        echo -e "  ${GREEN}Dashboard is accessible${NC}"
    else
        echo -e "  ${YELLOW}Dashboard may not be fully ready${NC}"
    fi

    echo ""
    echo -e "${CYAN}Parent App:${NC}"
    if curl -s -o /dev/null -w "%{http_code}" http://localhost:5173 | grep -q "200"; then
        echo -e "  ${GREEN}Parent app is accessible${NC}"
    else
        echo -e "  ${YELLOW}Parent app may not be fully ready${NC}"
    fi

    echo ""
    echo -e "${CYAN}System Resources:${NC}"
    echo "  CPU: $(top -bn1 | grep "Cpu(s)" | awk '{print $2}' | cut -d'%' -f1)% used"
    echo "  Memory: $(free -h | awk '/^Mem:/ {print $3 "/" $2}')"
    echo "  Disk: $(df -h / | awk 'NR==2 {print $3 "/" $2 " (" $5 ")"}')"

    echo ""
    echo "==============================================================="
    if $all_healthy; then
        echo -e "${GREEN}${BOLD}SYSTEM FULLY OPERATIONAL${NC}"
    else
        echo -e "${YELLOW}${BOLD}SYSTEM HAS ISSUES - Check logs with: kobeai-admin system logs${NC}"
    fi
}

show_stats() {
    echo -e "${BOLD}${CYAN}KobeAI System Statistics${NC}"
    echo "==============================================================="
    if curl -s http://localhost:8000/health &>/dev/null; then
        echo ""
        echo -e "${CYAN}Today's Activity:${NC}"
        curl -s http://localhost:8000/api/v1/admin/stats 2>/dev/null | jq . 2>/dev/null || echo "  (API stats not available)"
    fi
    echo ""
    echo -e "${CYAN}Container Resources:${NC}"
    docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}" $(docker ps --format '{{.Names}}' | grep kobeai) 2>/dev/null
}

show_connections() {
    echo -e "${BOLD}${CYAN}Active Connections${NC}"
    echo "==============================================================="
    echo ""
    echo -e "${CYAN}Connected Watches:${NC}"
    docker exec kobeai-redis redis-cli SCARD "online_devices" 2>/dev/null || echo "  0"
    echo ""
    echo -e "${CYAN}Active API Connections:${NC}"
    netstat -an | grep :8000 | grep ESTABLISHED | wc -l | xargs echo "  "
}

show_logs() {
    local service="$1"
    cd "$KOBEAI_HOME"
    if [[ -n "$service" ]]; then
        docker-compose logs -f --tail=100 "$service"
    else
        docker-compose logs -f --tail=50
    fi
}

create_backup() {
    local backup_dir="$KOBEAI_HOME/backups"
    local timestamp=$(date +%Y%m%d_%H%M%S)
    local backup_file="$backup_dir/kobeai_backup_$timestamp.tar.gz"
    mkdir -p "$backup_dir"
    echo -e "${CYAN}Creating backup...${NC}"
    cd "$KOBEAI_HOME"
    docker exec kobeai-postgres pg_dump -U kobeai kobeai > "$backup_dir/db_$timestamp.sql"
    tar -czf "$backup_file" .env docker-compose*.yml config/ 2>/dev/null
    echo -e "${GREEN}Backup created: $backup_file${NC}"
    echo "   Database: $backup_dir/db_$timestamp.sql"
}

restore_backup() {
    local backup_file="$1"
    if [[ -z "$backup_file" || ! -f "$backup_file" ]]; then
        echo -e "${RED}Usage: kobeai-admin restore <backup_file>${NC}"
        return 1
    fi
    echo -e "${YELLOW}This will overwrite current configuration!${NC}"
    read -p "Are you sure? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Cancelled."
        return 0
    fi
    cd "$KOBEAI_HOME"
    tar -xzf "$backup_file"
    echo -e "${GREEN}Configuration restored${NC}"
}

config_command() {
    case "$1" in
        show)
            echo -e "${CYAN}Current Configuration:${NC}"
            cat "$KOBEAI_HOME/.env" | grep -v "^#" | grep -v "^$"
            ;;
        set)
            if [[ -n "$2" && -n "$3" ]]; then
                sed -i "s/^$2=.*/$2=$3/" "$KOBEAI_HOME/.env"
                echo -e "${GREEN}Updated $2=$3${NC}"
            else
                echo -e "${RED}Usage: kobeai-admin config set <KEY> <VALUE>${NC}"
            fi
            ;;
        *)
            echo -e "${RED}Usage: kobeai-admin config show|set${NC}"
            ;;
    esac
}

set_server_url() {
    local url="$1"
    if [[ -z "$url" ]]; then
        echo -e "${RED}Usage: kobeai-admin server-url <url>${NC}"
        echo "Example: kobeai-admin server-url http://192.168.1.100:8000"
        return 1
    fi
    sed -i "s|^SERVER_URL=.*|SERVER_URL=$url|" "$KOBEAI_HOME/.env"
    echo -e "${GREEN}Server URL set to: $url${NC}"
    echo -e "${YELLOW}Restart services: kobeai-admin system restart${NC}"
}
