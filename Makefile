# relay-server ops. Targets all assume SSH to the Unraid host works as root.
# Run from this directory: `make deploy`, `make logs`, etc.

HOST       ?= root@10.10.20.201
REMOTE_DIR ?= /mnt/user/appdata/relay-server
HOST_PORT  ?= 8765
CONTAINER  ?= relay-server
IMAGE      ?= relay-server:latest
TOKEN_FILE ?= .deployed-token

# `printf '%s'` (not `echo`) so the file never gets a trailing newline — which
# would silently break `pbcopy < .deployed-token` paste flows downstream.
define WRITE_TOKEN
printf '%s' "$$TOKEN" > $(TOKEN_FILE)
endef

.PHONY: help deploy rotate-token sync build run logs health stop

help:
	@echo "Targets:"
	@echo "  deploy        sync code, rebuild image, restart container with current token"
	@echo "  rotate-token  generate a new token, save it locally, deploy with it"
	@echo "  logs          tail container logs (Ctrl-C to stop)"
	@echo "  health        curl GET /health and print response"
	@echo "  stop          stop & remove the container (does NOT touch the image)"

# Sync source, build, restart with whatever token is in $(TOKEN_FILE).
deploy: sync
	@test -s $(TOKEN_FILE) || (echo "ERROR: $(TOKEN_FILE) is empty. Run 'make rotate-token' first." && exit 1)
	@TOKEN=$$(cat $(TOKEN_FILE)) && \
	  ssh $(HOST) "cd $(REMOTE_DIR) && docker build -t $(IMAGE) . && docker rm -f $(CONTAINER) 2>/dev/null; docker run -d --name $(CONTAINER) --restart unless-stopped -p $(HOST_PORT):8080 -e RELAY_TOKEN='$$TOKEN' $(IMAGE)" && \
	  echo "✔ deployed $(CONTAINER) on $(HOST):$(HOST_PORT)"

# Generate a fresh token, persist it locally (no trailing newline), then deploy.
rotate-token:
	@TOKEN=$$(openssl rand -hex 24) && \
	  $(WRITE_TOKEN) && \
	  echo "✔ new token saved to $(TOKEN_FILE) ($$(wc -c < $(TOKEN_FILE)) bytes)"
	@$(MAKE) deploy
	@echo ""
	@echo "Remember to update the token in:"
	@echo "  • QLab Cue Viewer menu bar app → Preferences → Relay → Token"
	@echo "  • any web viewer URLs that hardcode it"

# Just push the code; doesn't restart the container.
sync:
	@rsync -az --delete \
	  --exclude node_modules --exclude .git --exclude .env --exclude $(TOKEN_FILE) \
	  ./ $(HOST):$(REMOTE_DIR)/

build:
	@ssh $(HOST) "cd $(REMOTE_DIR) && docker build -t $(IMAGE) ."

logs:
	@ssh -t $(HOST) "docker logs -f --tail 50 $(CONTAINER)"

health:
	@curl -s -m 5 https://relay.trv.as/health && echo ""

stop:
	@ssh $(HOST) "docker rm -f $(CONTAINER)" && echo "✔ stopped"
