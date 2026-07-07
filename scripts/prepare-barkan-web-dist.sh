#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
build_dir="$repo_root/apps/web/dist"

if [ ! -f "$build_dir/index.html" ]; then
  echo "Web app build index not found: $build_dir/index.html" >&2
  exit 1
fi

cp "$build_dir/index.html" "$build_dir/app.html"

cat > "$build_dir/robots.txt" <<'ROBOTS'
User-agent: *
Allow: /
Sitemap: /sitemap.xml
ROBOTS

cat > "$build_dir/sitemap.xml" <<'SITEMAP'
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>/</loc></url>
  <url><loc>/plans</loc></url>
  <url><loc>/docs-site</loc></url>
  <url><loc>/docs-site/integrations/openclaw</loc></url>
  <url><loc>/docs-site/integrations/hermes</loc></url>
  <url><loc>/docs-site/integrations/mcp</loc></url>
  <url><loc>/docs-site/security</loc></url>
  <url><loc>/docs-site/privacy-operations</loc></url>
</urlset>
SITEMAP
