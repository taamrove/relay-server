# relay-server ops. Targets all assume SSH to the Unraid host works as root.
# Run from this directory: `make deploy`, `make logs`, etc.

HOST       ?= root@10.10.20.201
REMOTE_DIR ?= /mnt/user/appdata/relay-server
HOST_PORT  ?= 8765
CONTAINER  ?= relay-server
IMAGE      ?= relay-server:latest
TOKEN_FILE ?= .deployed-token
# Optional separate password for editing shared custom cues. Empty/missing file
# = the relay falls back to RELAY_TOKEN for editing.
EDITOR_TOKEN_FILE ?= .deployed-editor-token
# Item store lives OUTSIDE $(REMOTE_DIR) on purpose: `sync` runs rsync --delete
# into REMOTE_DIR, which would wipe saved cues on every deploy.
DATA_HOST_DIR ?= /mnt/user/appdata/relay-server-data

# Per-role auth flags forwarded to the container. Override on the CLI:
#   make deploy PUBLIC_PUBLISHERS=true   ← let any client publish without token
#   make deploy PUBLIC_SUBSCRIBERS=false ← lock down viewer access too
PUBLIC_SUBSCRIBERS ?= true
PUBLIC_PUBLISHERS  ?= false

# Per-machine production settings, kept out of git. Put e.g.
#   PUBLIC_PUBLISHERS = true
# in .deploy.mk next to this Makefile so a plain `make deploy` reproduces how
# the live relay actually runs. (A deploy with the defaults once locked out a
# bridge that publishes without the token.)
-include .deploy.mk

# `printf '%s'` (not `echo`) so the file never gets a trailing newline — which
# would silently break `pbcopy < .deployed-token` paste flows downstream.
define WRITE_TOKEN
printf '%s' "$$TOKEN" > $(TOKEN_FILE)
endef

.PHONY: help deploy rotate-token rotate-editor-token sync build run logs health stop

help:
	@echo "Targets:"
	@echo "  deploy        sync code, rebuild image, restart container with current token"
	@echo "  rotate-token  generate a new token, save it locally, deploy with it"
	@echo "  rotate-editor-token  generate a separate password for editing shared cues, deploy"
	@echo "  logs          tail container logs (Ctrl-C to stop)"
	@echo "  health        curl GET /health and print response"
	@echo "  stop          stop & remove the container (does NOT touch the image)"

# Sync source, build, restart with whatever token is in $(TOKEN_FILE).
deploy: sync
	@test -s $(TOKEN_FILE) || (echo "ERROR: $(TOKEN_FILE) is empty. Run 'make rotate-token' first." && exit 1)
	@TOKEN=$$(cat $(TOKEN_FILE)) && EDITOR=$$(cat $(EDITOR_TOKEN_FILE) 2>/dev/null || true) && \
	  ssh $(HOST) "mkdir -p $(DATA_HOST_DIR) && cd $(REMOTE_DIR) && docker build -t $(IMAGE) . && docker rm -f $(CONTAINER) 2>/dev/null; docker run -d --name $(CONTAINER) --restart unless-stopped -p $(HOST_PORT):8080 -v $(DATA_HOST_DIR):/data -e DATA_DIR=/data -e RELAY_TOKEN='$$TOKEN' -e EDITOR_TOKEN='$$EDITOR' -e PUBLIC_SUBSCRIBERS='$(PUBLIC_SUBSCRIBERS)' -e PUBLIC_PUBLISHERS='$(PUBLIC_PUBLISHERS)' $(IMAGE)" && \
	  echo "✔ deployed $(CONTAINER) on $(HOST):$(HOST_PORT) (PUBLIC_SUBS=$(PUBLIC_SUBSCRIBERS) PUBLIC_PUBS=$(PUBLIC_PUBLISHERS))"

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

# Separate password for editing shared custom cues, so you can hand it to e.g.
# the stage manager without giving away the publisher token.
rotate-editor-token:
	@TOKEN=$$(openssl rand -hex 12) && \
	  printf '%s' "$$TOKEN" > $(EDITOR_TOKEN_FILE) && \
	  echo "✔ new editor token saved to $(EDITOR_TOKEN_FILE)"
	@$(MAKE) deploy

# Just push the code; doesn't restart the container.
sync:
	@rsync -az --delete \
	  --exclude node_modules --exclude .git --exclude .env --exclude $(TOKEN_FILE) --exclude $(EDITOR_TOKEN_FILE) --exclude .deploy.mk --exclude data \
	  ./ $(HOST):$(REMOTE_DIR)/

build:
	@ssh $(HOST) "cd $(REMOTE_DIR) && docker build -t $(IMAGE) ."

logs:
	@ssh -t $(HOST) "docker logs -f --tail 50 $(CONTAINER)"

health:
	@curl -s -m 5 https://relay.trv.as/health && echo ""

stop:
	@ssh $(HOST) "docker rm -f $(CONTAINER)" && echo "✔ stopped"
