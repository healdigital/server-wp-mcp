#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ErrorCode, McpError, ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import axios from 'axios';
import fs from 'fs/promises';

// Load site config from either WP_SITES_JSON (inline JSON blob) or WP_SITES_PATH (file).
// WP_SITES_JSON wins when both are set — useful for env-only deployments (Paperclip).
async function loadSiteConfig() {
	const inlineJson = process.env.WP_SITES_JSON;
	const configPath = process.env.WP_SITES_PATH;

	let rawConfig;
	if (inlineJson) {
		try {
			rawConfig = JSON.parse(inlineJson);
		} catch (error) {
			throw new Error(`WP_SITES_JSON is not valid JSON: ${error.message}`);
		}
	} else if (configPath) {
		try {
			const configData = await fs.readFile(configPath, 'utf8');
			rawConfig = JSON.parse(configData);
		} catch (error) {
			if (error.code === 'ENOENT') {
				throw new Error(`Config file not found at: ${configPath}`);
			}
			throw new Error(`Failed to load config: ${error.message}`);
		}
	} else {
		throw new Error("Either WP_SITES_JSON or WP_SITES_PATH environment variable is required");
	}

	const normalizedConfig = {};
	for (const [alias, site] of Object.entries(rawConfig)) {
		if (!site.URL || !site.USER || !site.PASS) {
			console.error(`Invalid configuration for site ${alias}: missing required fields`);
			continue;
		}
		normalizedConfig[alias.toLowerCase()] = {
			url: site.URL.replace(/\/$/, ''),
			username: site.USER,
			auth: site.PASS
		};
	}
	return normalizedConfig;
}

// WordPress client — uses ?rest_route= URL pattern instead of /wp-json/* permalink.
// Hostinger LiteSpeed WAF (and similar shared-hosting WAFs) blocks authenticated
// requests to /wp-json/* with 403; the query-string form bypasses that rule
// while remaining a fully supported WordPress REST API entry point.
class WordPressClient {
	constructor(site) {
		const config = {
			baseURL: site.url,
			headers: {
				'Content-Type': 'application/json',
				'Accept': 'application/json'
			}
		};

		if (site.auth) {
			const credentials = `${site.username}:${site.auth.replace(/\s+/g, '')}`;
			config.headers['Authorization'] = `Basic ${Buffer.from(credentials).toString('base64')}`;
		}

		this.client = axios.create(config);
	}

	async discoverEndpoints() {
		const response = await this.client.get('/', { params: { rest_route: '/' } });
		const routes = response.data?.routes ?? {};
		return Object.entries(routes).map(([path, info]) => ({
			methods: info.methods ?? [],
			namespace: info.namespace ?? 'wp/v2',
			endpoints: [path]
		}));
	}

	async makeRequest(endpoint, method = 'GET', params) {
		const path = endpoint.replace(/^\/wp-json/, '').replace(/^\/?/, '/');
		const config = { method, url: '/', params: { rest_route: path } };

		if (method === 'GET' && params) {
			config.params = { ...config.params, ...params };
		} else if (params) {
			config.data = params;
		}

		const response = await this.client.request(config);
		return response.data;
	}
}

async function main() {
	try {
		const siteConfig = await loadSiteConfig();
		const clients = new Map();

		for (const [alias, site] of Object.entries(siteConfig)) {
			clients.set(alias, new WordPressClient(site));
		}

		const server = new Server({
			name: "server-wp-mcp",
			version: "1.1.0"
		}, {
			capabilities: { tools: {} }
		});

		server.setRequestHandler(ListToolsRequestSchema, async () => ({
			tools: [{
				name: "wp_discover_endpoints",
				description: "The discovery operation maps all available REST API endpoints on a WordPress site and returns their methods and namespaces. This allows you to understand what operations are possible on a target WordPress site without having to manually specify endpoints, which is important because different WordPress websites can have many different and varying endpoints.",
				inputSchema: {
					type: "object",
					properties: {
						site: { type: "string", description: "Site alias" }
					},
					required: ["site"]
				}
			}, {
				name: "wp_call_endpoint",
				description: "The call operation executes specific REST API requests to the target WordPress sites using provided parameters and authentication. It handles both read and write operations. It determines which endpoint to use after the discovery operation is conducted.",
				inputSchema: {
					type: "object",
					properties: {
						site: { type: "string", description: "Site alias" },
						endpoint: { type: "string", description: "API endpoint path" },
						method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE", "PATCH"], default: "GET" },
						params: { type: "object", description: "Request parameters or body" }
					},
					required: ["site", "endpoint"]
				}
			}]
		}));

		server.setRequestHandler(CallToolRequestSchema, async (request) => {
			const { name, arguments: args } = request.params;
			const client = clients.get(args.site?.toLowerCase());
			if (!client) {
				throw new McpError(ErrorCode.InvalidParams, `Unknown site: ${args.site}`);
			}
			switch (name) {
				case "wp_discover_endpoints": {
					const endpoints = await client.discoverEndpoints();
					return { content: [{ type: "text", text: JSON.stringify(endpoints, null, 2) }] };
				}
				case "wp_call_endpoint": {
					const result = await client.makeRequest(args.endpoint, args.method, args.params);
					return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
				}
				default:
					throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
			}
		});

		const transport = new StdioServerTransport();
		await server.connect(transport);

		console.error(`WordPress MCP server started with ${clients.size} site(s) configured`);
	} catch (error) {
		console.error(`Server failed to start: ${error.message}`);
		process.exit(1);
	}
}

main();
