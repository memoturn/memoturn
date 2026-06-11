# Memoturn — root task runner for the Rust workspace.
# Run `make help` for the target list.
# The web surfaces (memoturn.ai + docs.memoturn.ai) live in the memoturn/web repo.

.PHONY: help node test bench demo

help: ## list targets
	@grep -E '^[a-z-]+:.*##' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-14s %s\n", $$1, $$2}'

node: ## run a local memoturnd node on :8080 (data under ./data)
	cargo run -p memoturnd

test: ## workspace unit + integration tests
	cargo test

bench: ## reproduce the README performance numbers
	cargo run --release -p memoturn-bench

demo: ## end-to-end agent-story walkthrough against a running node
	scripts/demo.sh
