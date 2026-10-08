#!/bin/bash
# Claude Code statusline: model, branch, context usage, remaining until compact

input=$(cat)

model=$(echo "$input" | jq -r '.model.display_name // .model.id // "?"')
used_pct=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
remaining_pct=$(echo "$input" | jq -r '.context_window.remaining_percentage // empty')

cwd=$(echo "$input" | jq -r '.workspace.current_dir // "."')
branch=$(git -C "$cwd" branch --show-current 2>/dev/null || echo "?")

# Format context usage
ctx=""
if [ -n "$used_pct" ]; then
    # Auto-compact fires at ~95% by default; show how far we are from that
    compact_at=95
    remaining_to_compact=$(awk "BEGIN {printf \"%.1f\", $compact_at - $used_pct}")
    ctx="${used_pct}% used (${remaining_to_compact}% to compact)"
else
    ctx="n/a"
fi

echo "${model} | ${branch} | ${ctx}"
