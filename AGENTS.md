# FocusMemory — Agent Search Protocol

## Core Principle

**Minimize round trips.** Each tool call costs tokens and latency. Choose the single tool that answers your question. Only chain tools when the first result explicitly points to what's missing.

## Declarative Attention & Chunk Focus Rules

`<focus magic_chunks="..."/>` is NOT a tool call. It is a plain-text marker written directly in your response body. Never wrap it in a tool_call. There is no tool named "focus".

### 1. Strict Syntax
You must use ONLY the `<focus>` tag with valid `magic_chunks` attributes.
- ALWAYS enclose attribute values in double quotes (`"`).
- ALWAYS close the tag with `/>` or `</focus>`. Never leave tags open or truncated.

### 2. Chunk Range Specification Rules
When specifying multiple chunks in `magic_chunks`, follow these strict format guidelines:
- **Comma-Separated Single Chunks ONLY:** Use comma separation for individual chunk IDs (e.g., `magic_chunks="7,8,9"`).
- **NO Hyphen Ranges:** Range syntax like `7-8` or `7~8` is STRICTLY FORBIDDEN. Always expand ranges into explicit comma-separated lists.
- **Single Chunk:** `magic_chunks="7"`

### 3. Examples

CORRECT:
- `<focus magic_chunks="7,8" />`
- `<focus magic_chunks="1,2,3,4" />`

INCORRECT:
- `<focus magic_chunks="7-8" />`   (hyphen range)
- `<focus magic_chunks=7,8>`       (missing quotes)

### 4. Output Safety
- NEVER output partial tags during Chain-of-Thought reasoning.
- Output the tag as a single, uninterrupted token block at the very end or designated control line.

## Decision Tree

```
Question received
│
├─ "Why was X done?" / "History of decision" / "What changed and why?"
│  → trace_decision_chain(query="X")
│  └─ If chain result is insufficient → search_memory(query) for broader context
│
├─ "Who calls X?" / "What does Y depend on?" / "Trace the call chain"
│  → trace_references(target="X")
│  └─ If no graph node found → search_file_structure(query="X") to find correct name
│
├─ "I need to work on file Z" / "Show me the context around Z"
│  → get_context_bundle(filepath="Z")
│  └─ Replaces: read_file + search_code + query_graph (3 calls → 1 call)
│
├─ "Where is the logic for X?" / "How does X work?" (code content)
│  → search_code(query="X")
│  └─ If results point to a specific file → get_context_bundle(filepath) for full context
│
├─ "What files contain X?" / "Find the file for X" (file location)
│  → search_file_structure(query="X")
│  └─ Returns exact filepaths + entities → use read_file or get_context_bundle
│
├─ "What did we decide about X?" / "Is there a past bug fix for X?"
│  → search_memory(query="X")
│  └─ If it contains decision context → trace_decision_chain for full chain
│
├─ "What's in the project docs?" / "DB schema" / "API spec"
│  → search_project_facts(query)
│
├─ "What work was done last session?" / "Any open todos?"
│  → search_work_memory(query)
│
└─ "General question about the codebase" (no clear category)
   → search_memory(query) — it auto-routes to the best backend
```

## Tool Reference

| Tool | One-line purpose | Use when... | Replaces |
|------|-----------------|-------------|----------|
| `search_memory` | Unified router → best backend + prune | You don't know which backend to hit | 2-3 separate calls |
| `search_code` | Semantic search over code chunks | You need the actual code logic | grep + read (for "how does X work?") |
| `query_graph` | Code structure lookup (Meilisearch) | You need file entities/imports | glob + grep for structure |
| `search_file_structure` | File name/path/keyword → filepath | You need to locate a file | glob + grep |
| `get_context_bundle` | File + chunks + callers in one call | You're about to read_file + search separately | read_file + search_code + query_graph |
| `trace_references` | Multi-hop caller/callee trace | You need dependency chains | Repeated query_graph calls |
| `trace_decision_chain` | Full causal history of a decision | "Why was X built this way?" | search_memory + manual chain walk |
| `search_work_memory` | Direct past-session search | Specific "what did we do last time?" | — |
| `search_project_facts` | Direct docs/plans search | Specific "what's in the schema?" | — |
| `remember_decision` | Write a decision to memory | Task complete with tests passing | — |
| `search_web` | Web search via local server | External knowledge needed | — |

## Stop Conditions (when to STOP searching)

- You have a concrete file path and line number → **read_file or get_context_bundle**, no more searching
- `search_memory` returned a relevant result with `[출처: file.md]` tag → **read_file that tag**, don't re-search
- `get_context_bundle` already returned file content + callers → **start coding**, no more context gathering
- You've called 2 tools and both point to the same file → **stop, you have enough context**
- Your answer only requires a single fact that's already in the conversation → **answer directly**

**Rule: maximum 3 search calls per question before you MUST act on what you have.**

## Concrete Examples

### Example 1: "Where is the Redis connection logic?"
```
1. search_code(query="Redis connection pool initialization")
   → Returns: redis.js:45-80, score 0.87
2. get_context_bundle(filepath="verbally_server/redis.js")
   → Full file + 3 related chunks + callers
→ DONE. Start coding. (2 calls, not 4-5)
```

### Example 2: "Why was the auth middleware changed from JWT to session?"
```
1. trace_decision_chain(query="auth middleware JWT session")
   → Returns full chain:
     [2025-03-10] "Use JWT" (superseded)
     [2025-07-22] "Switch to session-based" — reasoning: "stateless JWT caused 401 storms..."
     [2026-01-15] "Session with Redis backing" — reasoning: "in-memory sessions lost on pm2 restart"
→ DONE. You have the full "why". (1 call)
```

### Example 3: "What files reference the `callRestAPIAsync` function?"
```
1. trace_references(target="callRestAPIAsync", direction="callers", max_hops=2)
   → Returns: 12 callers across 8 files, 2-hop chain
→ DONE. (1 call)
```

### Example 4: "I need to add a new API endpoint in the place module"
```
1. search_memory(query="place module API endpoint pattern")
   → Returns: decision "REST API pattern uses Hono routes in /routes/" + [출처: docs/api-patterns.md]
2. get_context_bundle(filepath="verbally_server/routes/place.js")
   → Full route file + existing endpoint patterns + related chunks
→ DONE. You see the pattern, start coding. (2 calls)
```

## Hard Gate Rules (physically enforced by hooks)

| Rule | Mechanism | Effect |
|------|-----------|--------|
| `grep_search`/`glob` blocked until `search_memory` called | PreToolUse hook (deny) | You physically cannot grep before memory search |
| Bypass: explicit file path in query | PreToolUse hook (allow) | `grep_search(pattern, path="/specific/file.js")` is allowed without memory |
| Satisfied: turn state stamped this turn | PreToolUse hook (allow) | Auto-recall or `search_memory` stamped `memoryCalledEpoch == turnEpoch` in the shared state file — a stale stamp from an earlier turn (e.g. after a failed recall) never opens the gate |
| `## Search Results (Auto-injected)` header present | UserPromptSubmit HTTP hook | Memory search is already satisfied — do NOT re-call `search_memory` with same keywords |
| Completion signal + code change → ask to record | Stop hook (ask) | You'll be asked to call `remember_decision` at task completion |

**Key**: When you see `[Hard Gate] Call mcp__focus-memory__search_memory before using grep_search/glob` in a tool result, it means the hook blocked you. Call `search_memory` first, then retry your grep.

## Failure Modes & Recovery

| Failure | Symptom | Recovery |
|---------|---------|----------|
| Qdrant unreachable | "Qdrant search failed: connect ECONNREFUSED" | Proceed with `search_file_structure` (Meilisearch) or direct file reads |
| Meilisearch unreachable | "Meilisearch search failed" | Use `search_code` (Qdrant vector) instead |
| BGE embedding server down | "Embedding failed" on search_code/search_memory | Use `search_file_structure` or `query_graph` (keyword-based, no embedding needed) |
| Empty results from search_memory | "No relevant results found" | Try `search_code` with different phrasing, or `search_file_structure` with a keyword |
| Graph nodes stale | "No node found for 'X'" from trace_references | Call `search_file_structure(query="X")` to verify the correct name |
| File not found from get_context_bundle | "File not found: path" | Call `search_file_structure(query="filename")` to get correct path |
| SUMMARY_LLM unavailable | Results are unpruned (raw) | Not an error — results are just longer. Proceed with them |

## Write-back (remember_decision)

Call **once per completed task** when:
- Tests pass and a feature is delivered
- A bug root cause is identified and fixed
- An architectural decision is made

**Do NOT call** on every file edit or intermediate step.

Parameters:
- `summary_text` — what was decided
- `reasoning` — why (this is what makes chains useful)
- `topic_key` — leave empty for auto-inference
- `supersedes` — omit; auto-detection handles it via embedding similarity
