# Memoturn — root task runner for the Rust workspace.
# Run `make help` for the target list.
# docs.memoturn.ai lives in docs/site (cd docs/site && npm run dev|deploy); the
# memoturn.ai marketing site lives in the private memoturn/web repo.

.PHONY: help node test bench demo demos check fmt venv e2e

help: ## list targets
	@grep -E '^[a-z0-9-]+:.*##' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-14s %s\n", $$1, $$2}'

node: ## run a local memoturnd node on :8080 (data under ./data)
	cargo run -p memoturnd

test: ## workspace unit + integration tests
	cargo test

bench: ## reproduce the README performance numbers
	cargo run --release -p memoturn-bench

demo: ## end-to-end agent-story walkthrough against a running node
	scripts/demo.sh

demos: ## run all examples/ as an e2e suite (spawns a temp node if none is up)
	@if [ -x examples/.venv/bin/python ]; then examples/.venv/bin/python examples/run_e2e.py; \
	else python3 examples/run_e2e.py; fi

check: ## local CI-equivalent: fmt + clippy + workspace tests
	cargo fmt --all --check
	cargo clippy --workspace --all-targets -- -D warnings
	cargo test

fmt: ## format the workspace
	cargo fmt --all

venv: ## create examples/.venv with the demo dependencies
	python3 -m venv examples/.venv
	examples/.venv/bin/pip install -q -r examples/requirements.txt

e2e: ## SDK + MCP + examples e2e suites (TS SDK needs a node: `make node` first)
	cd mcp && npm ci --silent && npm test
	cd sdk/typescript && npm ci --silent && npm test
	$(MAKE) demos
