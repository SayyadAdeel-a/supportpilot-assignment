---
name: human-coder
description: "Enforces human-developer coding standards: eliminates AI slop, prevents over-engineering, avoids redundant comments, uses idiomatic patterns, and writes pragmatic, senior-level code as if written by an experienced human engineer."
---

# Human Coder & Pragmatic Engineering Standard

This skill guides AI agents to write code that looks, feels, and operates like high-caliber code written by an experienced human senior engineer—completely stripping away recognizable "AI slop" patterns.

## 1. Eliminate "AI Slop" & Over-Engineering
- **No Obvious Comments**: NEVER write comments that merely narrate what the code does (e.g., `# Loop through items`, `# Initialize lock`, `# Return response`). Humans only write comments explaining *why* a non-obvious constraint, race condition, or trade-off exists.
- **No Sterile/Mechanical Docstrings**: Avoid writing generic docstrings that just repeat the function signature (e.g., `"""Initializes the class with given parameters."""`). Keep docstrings concise and intentional.
- **No Over-Abstraction (YAGNI)**: Do not introduce abstract base classes, generic factory builders, strategy managers, or dependency injection wrappers for one-off concrete implementations. Write direct, readable, linear code.
- **Natural Naming**: Avoid theatrical, grandiose AI variable names (e.g., `robustExponentialBackoffStrategyHandler`, `comprehensiveResultAggregator`). Use standard, natural names that senior developers actually use (e.g., `backoff`, `delay`, `stream`, `unacked`, `pending`).

## 2. Idiomatic & Native Code
- **Match Local Codebase Style**: Mimic the surrounding code's formatting, indentation, import conventions, error-handling idioms, and logging patterns. Never impose a foreign template or rewrite unrelated code.
- **Pythonic Idioms**: Use standard Python idioms (list/dict comprehensions where clear, context managers, generator expressions, standard library tools like `queue.Queue`, `threading.Event`).
- **No Premature Optimization vs No Blatant Inefficiencies**: Write clean, efficient algorithms. Avoid locking large blocks of code, especially slow I/O operations (like disk writes or network calls).

## 3. Concurrency & Reliability (Senior Level)
- **Defensive Error Handling**: Catch specific exceptions (e.g., `grpc.RpcError`, `queue.Full`, `queue.Empty`), not naked `except:`.
- **Clean Invariant Preservation**: Ensure state invariants hold across thread boundaries. If an operation fails mid-flight (e.g., a network disconnect mid-stream), ensure data is not silently lost or dropped without telemetry.
- **Graceful Shutdown**: Implement clean termination semantics (drain buffers, close channels, join threads with reasonable timeouts).

## 4. Realistic Completeness
- Never leave behind placeholders like `# TODO: implement error handling here`, `# Add validation logic`, or stubbed `pass` blocks.
- Every function must be fully implemented, syntactically valid, and test-verified.
