import { Hono } from "hono";
import type { Env, Variables } from "../app.js";
import { TOOL_CATALOG, TOOL_COUNT, TOOL_NAMES } from "../lib/tool-catalog.js";

const utilityRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * Health check.
 *
 * Reports the tool manifest so it can be verified without going through an MCP
 * client. The names come from the same TOOL_CATALOG that mcp-agent.ts registers
 * from, so this cannot drift from what the Durable Object actually exposes.
 *
 * Pass ?verbose=1 to include each tool's description, which is the quickest way
 * to confirm a deploy actually shipped the descriptions a client ranks on.
 */
utilityRoutes.get("/health", (c) => {
	const verbose = c.req.query("verbose") === "1";

	return c.json({
		status: "healthy",
		transport: "streamable-http",
		version: "3.1.0",
		oauth: "enabled",
		tool_count: TOOL_COUNT,
		tools: TOOL_NAMES,
		...(verbose ? { tool_descriptions: TOOL_CATALOG } : {}),
	});
});

// Stats endpoint - show user and session counts
utilityRoutes.get("/stats", async (c) => {
	try {
		const kv = c.env.OAUTH_KV;

		// List all keys with prefix "hevy_key:" to count users
		const userKeys = await kv.list({ prefix: "hevy_key:" });
		const totalUsers = userKeys.keys.length;

		// List all keys with prefix "session:" to count active sessions
		const sessionKeys = await kv.list({ prefix: "session:" });
		const activeSessions = sessionKeys.keys.length;

		// List approval tokens (pending OAuth flows)
		const approvalKeys = await kv.list({ prefix: "approval:" });
		const pendingApprovals = approvalKeys.keys.length;

		return c.json({
			total_users: totalUsers,
			active_sessions: activeSessions,
			pending_approvals: pendingApprovals,
		});
	} catch (error) {
		console.error("Error fetching stats:", error);
		return c.json({
			error: "Failed to fetch stats",
			total_users: 0,
			active_sessions: 0,
			pending_approvals: 0,
		}, 500);
	}
});

// Root endpoint - show OAuth info
utilityRoutes.get("/", (c) => {
	const html = `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Hevy MCP Server</title>
	<style>
		* {
			margin: 0;
			padding: 0;
			box-sizing: border-box;
		}
		
		body {
			font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
			line-height: 1.6;
			color: #333;
			min-height: 100vh;
			padding: 2rem;
		}
		
		.container {
			max-width: 900px;
			margin: 0 auto;
			background: white;
			border-radius: 16px;
			box-shadow: 0 20px 60px rgba(0,0,0,0.3);
			overflow: hidden;
		}
		
		.header {
			background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
			color: white;
			padding: 3rem 2rem;
			text-align: center;
		}
		
		.header h1 {
			font-size: 2.5rem;
			margin-bottom: 0.5rem;
			font-weight: 700;
		}
		
		.status {
			display: inline-block;
			background: #10b981;
			color: white;
			padding: 0.4rem 1rem;
			border-radius: 20px;
			font-size: 0.9rem;
			font-weight: 600;
			margin-top: 0.5rem;
		}
		
		.setup-section {
			padding: 3rem 2rem;
			text-align: center;
			background: #f8fafc;
			border-bottom: 1px solid #e2e8f0;
		}
		
		.setup-section h2 {
			font-size: 1.5rem;
			color: #1e293b;
			margin-bottom: 1rem;
		}
		
		.setup-section p {
			color: #64748b;
			margin-bottom: 2rem;
			font-size: 1.1rem;
		}
		
		.setup-button {
			display: inline-block;
			background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
			color: white;
			padding: 1rem 3rem;
			border-radius: 8px;
			text-decoration: none;
			font-weight: 600;
			font-size: 1.1rem;
			transition: all 0.3s ease;
			box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
		}
		
		.setup-button:hover {
			transform: translateY(-2px);
			box-shadow: 0 6px 20px rgba(102, 126, 234, 0.6);
		}
		
		.features {
			padding: 3rem 2rem;
		}
		
		.features h2 {
			font-size: 1.8rem;
			color: #1e293b;
			margin-bottom: 2rem;
			text-align: center;
		}
		
		.feature-grid {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
			gap: 2rem;
			margin-bottom: 2rem;
		}
		
		.feature {
			background: white;
			padding: 2rem;
			border-radius: 12px;
			box-shadow: 0 4px 6px rgba(0, 0, 0, 0.05);
			border: 1px solid #e2e8f0;
		}
		
		.feature h3 {
			font-size: 1.2rem;
			color: #1e293b;
			margin-bottom: 1rem;
		}
		
		.feature p {
			color: #64748b;
			font-size: 0.95rem;
		}
		
		.footer {
			background: #1e293b;
			color: #94a3b8;
			padding: 2rem;
			text-align: center;
			font-size: 0.9rem;
		}
		
		.footer a {
			color: #60a5fa;
			text-decoration: none;
		}
		
		.footer a:hover {
			text-decoration: underline;
		}
		
		@media (max-width: 768px) {
			body {
				padding: 1rem;
			}
			
			.header h1 {
				font-size: 2rem;
			}
			
			.setup-button {
				padding: 0.8rem 2rem;
				font-size: 1rem;
			}
		}
	</style>
</head>
<body>
	<div class="container">
		<div class="header">
			<h1>Hevy MCP Server</h1>
			<p id="user-count" style="margin-top: 1rem; font-size: 1.1rem; opacity: 0.9;">Loading stats...</p>
		</div>
		
		<div class="setup-section">
			<h2>Get Started with Claude + Hevy</h2>
			<p>Connect your Hevy account to Claude for AI-powered workout tracking and analysis.</p>
			<a href="/setup" class="setup-button">🚀 Setup Your Account</a>
		</div>
		
		<div class="features">
			<h2>What You Can Do</h2>
			<div class="feature-grid">
				<div class="feature">
					<h3>📊 Track Workouts</h3>
					<p>Log, update, and analyze your workouts with AI assistance. Get insights into your training patterns.</p>
				</div>
				<div class="feature">
					<h3>📋 Manage Routines</h3>
					<p>Create and organize workout routines. Build custom programs tailored to your goals.</p>
				</div>
				<div class="feature">
					<h3>🏃 Exercise History</h3>
					<p>Track progress over time. See how your strength and performance evolve with detailed analytics.</p>
				</div>
				<div class="feature">
					<h3>🔐 Secure & Private</h3>
					<p>Your data stays private. OAuth authentication ensures only you can access your Hevy account.</p>
				</div>
			</div>
		</div>
		
		<div class="footer">
			<p>
				Built using <a href="https://modelcontextprotocol.io/" target="_blank">Model Context Protocol</a> 
				and <a href="https://developers.cloudflare.com/workers/" target="_blank">Cloudflare Workers</a>
			</p>
			<p>
				<a href="https://github.com/tomtorggler/hevy-mcp-server" target="_blank">View Source</a> •
				<a href="/health" target="_blank">Health Check</a> •
				<a href="/stats" target="_blank">Stats</a>
			</p>
		</div>
	</div>

	<script>
		// Fetch and display user stats
		fetch('/stats')
			.then(response => response.json())
			.then(data => {
				const userCountEl = document.getElementById('user-count');
				if (data.total_users !== undefined) {
					userCountEl.textContent = \`\${data.total_users} users • \${data.active_sessions} active sessions\`;
				} else {
					userCountEl.textContent = '';
				}
			})
			.catch(error => {
				console.error('Failed to load stats:', error);
				document.getElementById('user-count').textContent = '';
			});
	</script>
</body>
</html>`;

	return c.html(html);
});

export default utilityRoutes;
