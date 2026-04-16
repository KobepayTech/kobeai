#!/bin/bash
# ============================================
# KOBEAI MODEL MANAGEMENT
# ============================================

declare -A MODEL_INFO=(
    ["mistral:7b"]="Primary AI - General purpose (4.1 GB)"
    ["phi:2.7b"]="Fast fallback - Quick responses (1.6 GB)"
    ["deepseek-coder:6.7b"]="Math/Science specialist (3.8 GB)"
    ["nomic-embed-text"]="Semantic search embeddings (274 MB)"
)

models_command() {
    case "$1" in
        install)
            shift
            install_models "$@"
            ;;
        list)
            list_models
            ;;
        status)
            check_models_status
            ;;
        remove)
            remove_model "$2"
            ;;
        export)
            export_models "$2"
            ;;
        import)
            import_models "$2"
            ;;
        *)
            echo -e "${RED}Unknown models command: $1${NC}"
            echo "Use: install, list, status, remove, export, import"
            return 1
            ;;
    esac
}

install_models() {
    local specific_model=""
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --model)
                specific_model="$2"
                shift 2
                ;;
            *)
                shift
                ;;
        esac
    done

    echo -e "${BOLD}${GREEN}KOBEAI MODEL INSTALLATION${NC}"
    echo ""

    if ! docker ps | grep -q kobeai-ollama; then
        echo -e "${YELLOW}Ollama is not running. Starting...${NC}"
        docker start kobeai-ollama 2>/dev/null || {
            echo -e "${RED}Cannot start Ollama. Is KobeAI installed?${NC}"
            return 1
        }
        sleep 5
    fi

    echo -e "${CYAN}Checking internet connectivity...${NC}"
    if ! curl -s --connect-timeout 5 https://ollama.com > /dev/null; then
        echo -e "${RED}No internet connection. Models must be downloaded.${NC}"
        echo -e "${YELLOW}Use 'kobeai-admin models import' to install from offline package.${NC}"
        return 1
    fi
    echo -e "${GREEN}Internet connected${NC}"
    echo ""

    if [[ -n "$specific_model" ]]; then
        install_single_model "$specific_model"
    else
        echo -e "${BOLD}Available models to install:${NC}"
        echo ""
        for model in "${!MODEL_INFO[@]}"; do
            printf "  ${CYAN}%-25s${NC} - %s\n" "$model" "${MODEL_INFO[$model]}"
        done
        echo ""
        echo -e "${YELLOW}Total download size: ~10 GB${NC}"
        echo -e "${YELLOW}Estimated time: 15-30 minutes${NC}"
        echo ""
        read -p "Continue with installation? (y/n) " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            echo -e "${YELLOW}Installation cancelled.${NC}"
            return 0
        fi
        install_all_models
    fi
}

install_single_model() {
    local model="$1"

    if [[ -z "${MODEL_INFO[$model]}" ]]; then
        echo -e "${RED}Unknown model: $model${NC}"
        echo "Available models: ${!MODEL_INFO[@]}"
        return 1
    fi

    echo -e "${CYAN}Downloading $model...${NC}"
    echo -e "${YELLOW}   Size: ${MODEL_INFO[$model]}${NC}"
    echo ""

    show_progress() {
        local pid=$1
        local delay=0.5
        local spinstr='|/-\'
        while ps -p $pid > /dev/null; do
            local temp=${spinstr#?}
            printf "  [%c] Downloading... " "$spinstr"
            local spinstr=$temp${spinstr%"$temp"}
            sleep $delay
            printf "\r"
        done
        printf "    \r"
    }

    docker exec kobeai-ollama ollama pull "$model" &
    local pull_pid=$!
    show_progress $pull_pid
    wait $pull_pid

    if docker exec kobeai-ollama ollama list | grep -q "$model"; then
        echo -e "${GREEN}Successfully installed: $model${NC}"
    else
        echo -e "${RED}Failed to install: $model${NC}"
        return 1
    fi
}

install_all_models() {
    local total=${#MODEL_INFO[@]}
    local current=0
    local failed=0

    for model in "${!MODEL_INFO[@]}"; do
        ((current++))
        echo -e "\n${BOLD}${CYAN}[$current/$total] Installing $model...${NC}"
        if install_single_model "$model"; then
            echo -e "${GREEN}   Complete${NC}"
        else
            echo -e "${RED}   Failed${NC}"
            ((failed++))
        fi
    done

    echo ""
    if [[ $failed -eq 0 ]]; then
        echo -e "${GREEN}All models installed successfully!${NC}"
    else
        echo -e "${YELLOW}Installation complete with $failed failure(s)${NC}"
    fi
    echo ""
    list_models
}

list_models() {
    echo -e "${BOLD}${CYAN}Installed AI Models:${NC}"
    echo ""
    if ! docker ps | grep -q kobeai-ollama; then
        echo -e "${YELLOW}Ollama is not running. Start with: kobeai-admin system start${NC}"
        return 1
    fi
    docker exec kobeai-ollama ollama list 2>/dev/null || {
        echo -e "${YELLOW}No models installed yet.${NC}"
        echo "Run: kobeai-admin models install"
    }
}

check_models_status() {
    echo -e "${BOLD}${CYAN}Model Status Check:${NC}"
    echo ""
    if ! docker ps | grep -q kobeai-ollama; then
        echo -e "${RED}Ollama is not running${NC}"
        return 1
    fi
    local installed=$(docker exec kobeai-ollama ollama list 2>/dev/null | tail -n +2 | awk '{print $1}')

    printf "%-30s %-15s %s\n" "MODEL" "STATUS" "SIZE"
    echo "----------------------------------------------------------------"
    for model in "${!MODEL_INFO[@]}"; do
        if echo "$installed" | grep -q "${model%:*}"; then
            printf "%-30s ${GREEN}%-15s${NC} %s\n" "$model" "INSTALLED" "${MODEL_INFO[$model]##* }"
        else
            printf "%-30s ${RED}%-15s${NC} %s\n" "$model" "MISSING" "${MODEL_INFO[$model]##* }"
        fi
    done
    echo ""

    local all_installed=true
    for model in "${!MODEL_INFO[@]}"; do
        if ! echo "$installed" | grep -q "${model%:*}"; then
            all_installed=false
            break
        fi
    done

    if $all_installed; then
        echo -e "${GREEN}All models are installed and ready!${NC}"
    else
        echo -e "${YELLOW}Some models are missing. Run: kobeai-admin models install${NC}"
    fi
}

remove_model() {
    local model="$1"
    if [[ -z "$model" ]]; then
        echo -e "${RED}Usage: kobeai-admin models remove <model_name>${NC}"
        list_models
        return 1
    fi
    echo -e "${YELLOW}This will remove the model: $model${NC}"
    read -p "Are you sure? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Cancelled."
        return 0
    fi
    docker exec kobeai-ollama ollama rm "$model"
    echo -e "${GREEN}Model removed: $model${NC}"
}

export_models() {
    local output="${1:-$HOME/kobeai-models-$(date +%Y%m%d).tar.gz}"
    echo -e "${BOLD}${CYAN}Exporting AI Models...${NC}"
    echo ""
    if ! docker exec kobeai-ollama ollama list | grep -q "mistral"; then
        echo -e "${YELLOW}No models found to export.${NC}"
        echo "Run: kobeai-admin models install"
        return 1
    fi
    echo -e "${YELLOW}Stopping Ollama to ensure data consistency...${NC}"
    docker stop kobeai-ollama
    echo -e "${CYAN}Creating archive...${NC}"
    cd "$KOBEAI_HOME/data"
    tar -czf "$output" ollama/ 2>/dev/null
    echo -e "${YELLOW}Starting Ollama...${NC}"
    docker start kobeai-ollama
    local size=$(du -h "$output" | cut -f1)
    echo -e "${GREEN}Models exported to: $output${NC}"
    echo -e "${GREEN}   Size: $size${NC}"
    echo ""
    echo -e "${CYAN}To import on another server:${NC}"
    echo "   kobeai-admin models import $output"
}

import_models() {
    local archive="$1"
    if [[ -z "$archive" || ! -f "$archive" ]]; then
        echo -e "${RED}Usage: kobeai-admin models import <archive_file>${NC}"
        echo "Archive must be a .tar.gz file created with 'models export'"
        return 1
    fi
    echo -e "${BOLD}${CYAN}Importing AI Models from offline package...${NC}"
    echo ""
    local size=$(du -h "$archive" | cut -f1)
    echo -e "Archive: $archive"
    echo -e "Size: $size"
    echo ""
    echo -e "${YELLOW}Stopping Ollama...${NC}"
    docker stop kobeai-ollama
    echo -e "${CYAN}Extracting models...${NC}"
    cd "$KOBEAI_HOME/data"
    rm -rf ollama/ 2>/dev/null || true
    tar -xzf "$archive"
    echo -e "${YELLOW}Starting Ollama...${NC}"
    docker start kobeai-ollama
    sleep 5
    echo ""
    echo -e "${GREEN}Models imported successfully!${NC}"
    echo ""
    list_models
}
