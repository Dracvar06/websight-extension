#!/bin/bash
# Local search engine for WebSight (SearXNG): asks the big search engines
# without an account or key, for "take me to the admissions page" and for
# answers elsewhere on a site. Listens only on this computer, port 8888.
# Extension settings: Search engine "SearXNG", address http://localhost:8888
cd "$(dirname "$0")/search-server"
export SEARXNG_SETTINGS_PATH="$PWD/settings.yml"
exec .venv/bin/python -m searx.webapp
