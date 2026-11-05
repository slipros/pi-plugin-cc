# Installing this checkout as a plugin, without going through GitHub.
#
# The published route is the marketplace in the README: push, then let every
# machine pull the release. This file is the other one — the working copy itself
# registered as a directory marketplace, so an edit reaches the installed plugin
# with one `make update` instead of a push and a refresh.
#
# `make install` binds the installation to the current path of this directory:
# moving the checkout means running it again.
#
# The marketplace name here is the same `pi-tools` the GitHub one uses (it comes
# from .claude-plugin/marketplace.json, which both share). If this machine still
# has the GitHub marketplace registered, drop it first — `make uninstall`, or
# `claude plugin marketplace remove pi-tools` — or the name collides.

SHELL       := /bin/bash
ROOT        := $(patsubst %/,%,$(dir $(abspath $(lastword $(MAKEFILE_LIST)))))
MARKETPLACE := pi-tools
PLUGIN      := pi
PLUGIN_DIR  := $(ROOT)/plugins/$(PLUGIN)
CLAUDE      ?= claude
BIN_DIR     ?= $(HOME)/.local/bin
PI          ?= $(BIN_DIR)/pia
PI_SANDBOX  ?= $(HOME)/.claude/pi/sandbox
SANDBOX_DIR := $(ROOT)/plugins/$(PLUGIN)/sandbox

.DEFAULT_GOAL := help
.PHONY: help install update check-marketplace update-cc update-pi uninstall reinstall validate test status link

help: ## List the targets
	@awk 'BEGIN{FS=":.*##"} /^[a-z-]+:.*##/ {printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: validate ## Register this directory as a marketplace and install the plugin
	$(CLAUDE) plugin marketplace add "$(ROOT)"
	$(CLAUDE) plugin install $(PLUGIN)@$(MARKETPLACE) -y
	@$(MAKE) --no-print-directory status

# Why not `claude plugin update`: with a bare name it does not resolve the
# plugin at all, and with `plugin@marketplace` it compares the `version` field
# and copies nothing when the two are equal. Version is frozen at 0.1.0 here, so
# that path reports success and leaves the installed copy on the old code.
# `install` always copies the directory whole, which is why an update is a
# reinstall. (The other fix is to bump `version` in both manifests — that is the
# only one a user installing from GitHub has.)
#
# Uninstall refuses while another Claude Code session holds the installed copy.
# Close the other sessions — this one included — if it does.
update: validate update-cc update-pi ## Copy the current checkout into BOTH harnesses

# The name `pi-tools` is shared with the GitHub marketplace this repo publishes
# to, and `marketplace add` does not displace a registration that already holds
# the name. Leave the GitHub one registered and every `make update` refreshes a
# git clone instead of this directory: the reinstall runs, reports success, and
# installs origin/main. Nothing in the output says so — the only visible symptom
# is an edit that never takes effect. Hence a check before anything is touched,
# and a non-zero exit rather than a warning: a silent failure is what this cost.
# The CLI labels a local source `Directory (...)` in older releases and
# `Folder (...)` in newer ones; matching only one turns the check into a false
# FATAL on the very registration it is meant to confirm.
check-marketplace: ## Fail unless `$(MARKETPLACE)` is registered as THIS directory
	@src=$$($(CLAUDE) plugin marketplace list 2>/dev/null | awk -v m="$(MARKETPLACE)" '$$NF==m{getline; print; exit}'); \
	case "$$src" in \
		*"Directory ($(ROOT))"*|*"Folder ($(ROOT))"*) echo "mp-check: $(MARKETPLACE) -> $(ROOT) (this checkout)" ;; \
		"") echo "mp-check: FATAL — marketplace $(MARKETPLACE) is not registered"; \
		    echo "  register this checkout with: make install"; \
		    exit 1 ;; \
		*) echo "mp-check: FATAL — $(MARKETPLACE) is registered elsewhere:"; \
		   echo "  $$src"; \
		   echo "  a reinstall would install THAT source, not this checkout"; \
		   echo "  fix: claude plugin marketplace remove $(MARKETPLACE) && make install"; \
		   exit 1 ;; \
	esac

update-cc: check-marketplace ## Claude Code only: refresh the marketplace and reinstall the plugin
	$(CLAUDE) plugin marketplace update $(MARKETPLACE)
	$(CLAUDE) plugin uninstall $(PLUGIN)@$(MARKETPLACE) -y
	$(CLAUDE) plugin install $(PLUGIN)@$(MARKETPLACE) -y
	@$(MAKE) --no-print-directory status
	@echo "Restart the Claude Code session for the change to take effect."

# The pi half has nothing to install. `pia` is a symlink into this checkout
# (`make link`), so the CLI is already live; what the pi side actually runs from
# elsewhere is the sandbox image, and it is built from the Dockerfiles in the
# user's own pi directory — not from the one this repo ships. So this half
# checks rather than copies, and it checks the two things that go wrong quietly:
# the shim in PATH pointing at a different checkout, a live sandbox file that has
# drifted from the one this repo ships, and an image holding an older pi than the
# host. None of the three shows up in the CLI output; each means the agent runs
# something nobody chose. The shim is fatal — it makes the whole update a
# no-op for the CLI. The Dockerfile drift stays a warning: the live file is the
# owner's to diverge, and a rebuild is not part of an update anyway.
#
# A rebuild is minutes and gigabytes, so it is opt-in: PI_REBUILD=1 make update.
update-pi: ## pi only: check that the pi side runs THIS checkout, not another one
	@if [ ! -x "$(PI)" ]; then \
		echo "pi-sync: no pia shim at $(PI) — run 'make link' if this machine uses pi"; \
	else \
		target=$$(readlink "$(PI)" || echo "$(PI)"); \
		case "$$target" in \
			"$(ROOT)"/*) echo "pi-sync: pia -> $$target (this checkout)" ;; \
			*) echo "pi-sync: FATAL — pia points outside this checkout: $$target"; \
			   echo "  edits here will not reach the CLI; 'make link' repoints it"; \
			   exit 1 ;; \
		esac; \
	fi
	@drift=0; \
	for shipped in $(SANDBOX_DIR)/*; do \
		[ -f "$$shipped" ] || continue; \
		name=$$(basename "$$shipped"); \
		live="$(PI_SANDBOX)/$$name"; \
		[ "$$name" = "Dockerfile" ] && live="$(PI_SANDBOX)/base.Dockerfile"; \
		[ -f "$$live" ] || continue; \
		diff -q "$$shipped" "$$live" >/dev/null 2>&1 && continue; \
		if [ $$drift -eq 0 ]; then \
			echo "pi-sync: WARN — live sandbox files have drifted from the ones this repo ships"; \
			drift=1; \
		fi; \
		echo "  $$name"; \
		echo "    shipped: $$shipped"; \
		echo "    live:    $$live"; \
	done; \
	[ $$drift -eq 1 ] && echo "  diff them before assuming the sandbox matches this checkout"; \
	true
	@if [ -x "$(PI)" ] && command -v docker >/dev/null 2>&1; then \
		host=$$(command -v pi >/dev/null 2>&1 && pi --version 2>/dev/null | tr -dc '0-9.'); \
		for img in $$($(PI) sandbox status 2>/dev/null | awk -F'`' '/^- `/{print $$2}'); do \
			baked=$$(docker run --rm --entrypoint pi "$$img" --version 2>/dev/null | tr -dc '0-9.'); \
			[ -n "$$baked" ] || continue; \
			if [ -z "$$host" ] || [ "$$baked" = "$$host" ]; then \
				echo "pi-sync: $$img runs pi $$baked"; \
			else \
				echo "pi-sync: WARN — $$img runs pi $$baked, the host runs $$host"; \
				echo "  an image keeps the version it was built with: PI_REBUILD=1 make update-pi"; \
			fi; \
		done; \
	fi
	@if [ -x "$(PI)" ]; then \
		if [ "$(PI_REBUILD)" = "1" ]; then \
			$(PI) sandbox build --all; \
		else \
			$(PI) sandbox status 2>/dev/null | awk '/^## Images/{f=1;next} /^## /{f=0} f && NF' | sed 's/^/  /'; \
			echo "  (rebuild with: PI_REBUILD=1 make update-pi)"; \
		fi; \
	fi

uninstall: ## Remove the plugin and unregister the marketplace
	-$(CLAUDE) plugin uninstall $(PLUGIN)@$(MARKETPLACE) -y
	-$(CLAUDE) plugin marketplace remove $(MARKETPLACE)

reinstall: uninstall install ## Install from scratch

validate: ## Check the plugin and marketplace manifests (--strict)
	$(CLAUDE) plugin validate --strict "$(PLUGIN_DIR)"
	$(CLAUDE) plugin validate --strict "$(ROOT)"

test: ## Run the test suite
	npm test

# The shim in PATH is a symlink, and a symlink into a marketplace clone dies
# with that clone: switching away from the GitHub marketplace leaves `pia`
# pointing at a directory that is no longer there. Pointed at the checkout it
# survives every install and uninstall below.
link: ## Point `pia` in PATH at this checkout
	@mkdir -p "$(BIN_DIR)"
	ln -sfn "$(ROOT)/bin/pia" "$(BIN_DIR)/pia"
	@echo "$(BIN_DIR)/pia -> $(ROOT)/bin/pia"

status: ## Installation state and what the plugin contains
	@$(CLAUDE) plugin list 2>/dev/null | grep -A3 '$(PLUGIN)@$(MARKETPLACE)' || echo "  plugin not installed"
	@$(CLAUDE) plugin details $(PLUGIN) 2>/dev/null | sed -n '5,11p' || true
