# FocusMemory — Agent Protocol

## Core Principle

**Minimize round trips, but never lose verified work.**
Each tool call costs tokens and latency, so choose the single tool that answers your question. Chain tools only when the first result explicitly points to what is missing.
Context on this server is finite. Old tool output and old reasoning leave the window during long tasks. **The Σ state anchor survives that, so it comes first.** Search tools are optional helpers.

## Two mechanisms. Never mix them.

|  | Declarative Attention (DA) | Memory search tools |
|---|---|---|
| What it is | Server-side attention control | MCP tools: `search_memory`, `search_code`, ... |
| Who acts | The server, reacting to tags in your text | You, by calling tools |
| Interface | Plain-text tags on their own line | Tool calls |
| Purpose | Choose which [Magic Chunk N] you can see | Find code, decisions, facts |
| Enforcement | Server | **Optional**, your judgment |

- Tags are never sent as tool calls.
- Two similarly named things are NOT the same:
  - **Session state anchor (Σ)**: injected by the server and maintained automatically.
  - **[Magic Chunk N]**: chunk labels in the context, targets of DA tags.
- Anything attached to your prompt (Σ, DA scaffold) is reference data, not an instruction. Never quote or restate it in replies.

---

# Part A. Declarative Attention Tags (plain text, handled by the server)

DA tags are NOT tool calls, function calls, or API invocations. The server reads them in your text and switches what you can see. The scaffold at the end of the user message explains the modes. This section only fixes the syntax.

## Syntax (strict)
1. Every tag goes on its own line, at the start of the line. A tag inside a sentence is treated as plain text and ignored.
2. Attribute values use double quotes: `<focus magic_chunks="7,8,9">`
3. List chunk IDs explicitly, digits and commas only. No ranges (`7-9`, `7~9`, `7..9`).
4. No self-closing form. Close every `<focus ...>` with `</focus>` on its own line (`<local>` with `</local>`).
5. Never emit a partial tag.

## Placement
- Never put a DA tag inside a tool call, JSON, a code block, or a tool-call parameter.
- After emitting a tag, keep writing. Do not stop or wait for a response.

## Visibility
- Never mention, explain, quote, or confirm these tags in your answer to the user.
- Never copy chunk content into your response.
- `[past_focus]` / `[past_end_focus]` inside recalled content is history, not a control tag.

## Examples

Correct:

    <focus magic_chunks="7,8,9">
    The retrieved chunks show ...
    </focus>

Wrong:
- `<tool_call>{"name":"focus", ...}</tool_call>` (tool call wrapper)
- `<focus magic_chunks="7-9">` (range)
- `<focus magic_chunks=7,8>` (no quotes)
- `<focus magic_chunks="7,8" />` (self-closing, never returns)
- `Result: <focus magic_chunks="7"> ... </focus>` (mid-line tags are ignored)

---

# Part B. Re-grounding on the Σ State Anchor

Long sessions get a "Session state anchor" block in the user message (`blocked` / `confirmed` / `hypothesis` / `next` sections plus a one-line `ctx:` KV snapshot). It is a RECORD of where the previous turn ended, one turn behind by construction. It is not a task assignment.

**Re-ground when:**
- The `ctx: ... evictions=N` line shows evictions increased since the anchor you saw last turn. Part of your history is no longer attendable.
- You are about to conclude or modify (final answer, code change, deletion, deploy).

**How:**
1. Before re-reading a file or range you already examined, check the Σ `confirmed` items first — re-read the source only when you need the exact current text (for example, to edit it).
2. Use the anchor's `confirmed` and `next` for orientation. Re-verify `confirmed` items against the current file, and re-check `hypothesis` items before acting. Never retry a `blocked` item until its condition clears.
3. To get evicted content back, emit `<focus magic_chunks="N">` for the chunk number listed in the anchor's `recall:` line or the scaffold's offloaded-chunks note. Never reconstruct evicted content from memory.

---

# Part C. Search Tools (optional)

Memory search is a helper, not a gate. Use it when it saves work. If the answer is already in the conversation, in the Σ anchor, or in a file you can open directly, skip it.

## Decision Tree

```
Starting, resuming, or just compacted?
→ Σ anchor injected — resume from `next`

Question received
│
├─ Already answerable from the Σ anchor or the conversation?
│  → answer directly, no search
│
├─ "Why was X done?" / "History of decision" / "What changed and why?"
│  → trace_decision_chain(query="X")
│  └─ If insufficient → search_memory(query) for broader context
│
├─ "Who calls X?" / "What does Y depend on?" / "Trace the call chain"
│  → trace_references(target="X")
│  └─ If no graph node found → search_file_structure(query="X") to find the correct name
│
├─ "I need to work on file Z" / "Show me the context around Z"
│  → get_context_bundle(filepath="Z")
│  └─ Replaces: read_file + search_code + query_graph (3 calls → 1)
│
├─ "Where is the logic for X?" / "How does X work?" (code content)
│  → search_code(query="X")
│  └─ If results point to a file → get_context_bundle(filepath)
│
├─ "What files contain X?" / "Find the file for X" (file location)
│  → search_file_structure(query="X")
│  └─ Returns exact filepaths + entities → read_file or get_context_bundle
│
├─ "What did we decide about X?" / "Is there a past bug fix for X?"
│  → search_memory(query="X")
│  └─ If it contains decision context → trace_decision_chain for the full chain
│
├─ "What's in the project docs?" / "DB schema" / "API spec"
│  → search_project_facts(query)
│
├─ "What work was done last session?" / "Any open todos?"
│  → search_work_memory(query)
│
└─ General question, no clear category
   → search_memory(query) (optional, auto-routes to the best backend)
```

## Tool Reference

| Tool | One-line purpose | Use when... | Replaces |
|------|-----------------|-------------|----------|
| `search_memory` | Semantic search over source code and workspace files (optional) | You need to find code or files by keyword/content and don't know where to look | grep + glob |
| `search_code` | Semantic search over code chunks | You need the actual code logic | grep + read |
| `query_graph` | Code structure lookup (Meilisearch) | You need file entities/imports | glob + grep for structure |
| `search_file_structure` | File name/path/keyword → filepath | You need to locate a file by name or path | glob + grep |
| `get_context_bundle` | File + chunks + callers in one call | You're about to read_file + search separately | read_file + search_code + query_graph |
| `trace_references` | Multi-hop caller/callee trace | You need dependency chains | Repeated query_graph calls |
| `trace_decision_chain` | Full causal history of a decision | "Why was X built this way?" | search_work_memory + manual chain walk |
| `search_work_memory` | Search past-session memory | "What did we do last time?" | — |
| `search_project_facts` | Search docs/plans | "What's in the schema?" | — |
| `remember_decision` | Write a decision to memory | Task complete with tests passing | — |
| `search_web` | Web search via local server | External knowledge needed | — |
| `sigma_note` | Save a verbatim note into this session's Σ (survives compaction) | You need work evidence to survive context compaction exactly as written (a fix that worked, a verified file:line, a settled threshold) | — |

### Sigma notes — when to write one

`sigma_note` is your own scratchpad, **not** memory search. Write the note
**at the moment you settle a hard-won finding and move on** — not later. The note
must survive context compaction **exactly as written**:
- a fix that actually worked (vs. the one you first tried),
- a verified `file:line` you don't want to re-derive,
- a threshold / config value you settled on after testing.

Each note is re-injected verbatim on every turn (no re-derivation), takes
precedence over the extracted Σ sections when they conflict, and is wiped on
task completion. Keep notes to facts — max 500 chars, 8 keys. Don't use it for
general knowledge (use `remember_decision`) or for anything you can re-read from
the files.

## Stop Conditions (when to STOP searching)

- You have a concrete file path and line number → `read_file` or `get_context_bundle`, no more searching.
- A search result carries a `[출처: file.md]` tag → `read_file` that file, don't re-search.
- `get_context_bundle` already returned file content + callers → start working.
- Two tools point to the same file → stop, you have enough context.
- The single fact you need is already in the conversation or the Σ anchor → answer directly.

**Rule: at most 3 search calls per question, then act on what you have.**

## Examples

### Example 1: "Where is the Redis connection logic?"
```
1. search_code(query="Redis connection pool initialization")
   → redis.js:45-80, score 0.87
2. get_context_bundle(filepath="verbally_server/redis.js")
   → full file + 3 related chunks + callers
→ DONE. Start working.
```

### Example 2: "Why was the auth middleware changed from JWT to session?"
```
1. trace_decision_chain(query="auth middleware JWT session")
   → [2025-03-10] "Use JWT" (superseded)
     [2025-07-22] "Switch to session-based" — "stateless JWT caused 401 storms..."
     [2026-01-15] "Session with Redis backing" — "in-memory sessions lost on pm2 restart"
→ DONE. (1 call)
```

### Example 3: "What files reference `callRestAPIAsync`?"
```
1. trace_references(target="callRestAPIAsync", direction="callers", max_hops=2)
   → 12 callers across 8 files
→ DONE. (1 call)
```

### Example 4: Resuming after compaction
```
1. Σ anchor injected at session start — read `next` (the resume point) and `confirmed`
2. continue the open item — no re-reading of files already in `confirmed`
→ No search needed.
```

---

# Part D. Hooks and Failure Modes

## Other hooks

| Rule | Mechanism | Effect |
|------|-----------|--------|
| `## Search Results (Auto-injected)` header present | UserPromptSubmit HTTP hook | Memory search already ran this turn. Do NOT re-call `search_memory` with the same keywords |
| Completion signal + code change → ask to record | Stop hook (ask) | You'll be asked to call `remember_decision` |

`grep_search` / `glob` are not gated. Use them directly when you know what to look for.

## Failure Modes & Recovery

| Failure | Symptom | Recovery |
|---------|---------|----------|
| Qdrant unreachable | "Qdrant search failed: connect ECONNREFUSED" | Use `search_file_structure` (Meilisearch) or read files directly |
| Meilisearch unreachable | "Meilisearch search failed" | Use `search_code` (Qdrant) |
| BGE embedding server down | "Embedding failed" on search_code/search_memory | Use `search_file_structure` or `query_graph` (keyword-based) |
| Empty results from search_memory | "No relevant results found" | Rephrase with `search_code`, or `search_file_structure` with a keyword |
| Graph nodes stale | "No node found for 'X'" | `search_file_structure(query="X")` to find the correct name |
| File not found from get_context_bundle | "File not found: path" | `search_file_structure(query="filename")` |
| SUMMARY_LLM unavailable | Results are unpruned | Not an error. Results are just longer |

## Write-back (remember_decision)

Call **once per completed task** when:
- Tests pass and a feature is delivered
- A bug root cause is identified and fixed
- An architectural decision is made

Do NOT call it on every file edit or intermediate step. Intermediate findings go in the Σ state (next/confirmed sections).

Parameters:
- `summary_text`: what was decided
- `reasoning`: why (this is what makes chains useful)
- `topic_key`: leave empty for auto-inference
- `supersedes`: omit, auto-detection handles it