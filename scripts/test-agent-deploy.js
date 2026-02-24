#!/usr/bin/env node
/**
 * Test agent deployment functionality
 * Tests both Cursor Cloud Agents and Claude Code agent deployment.
 *
 * Usage:
 *   node scripts/test-agent-deploy.js                    # Test configuration
 *   node scripts/test-agent-deploy.js cursor "prompt"    # Deploy Cursor agent
 *   node scripts/test-agent-deploy.js claude "prompt"    # Deploy Claude agent
 *   node scripts/test-agent-deploy.js parse "voice cmd"  # Test command parsing
 */
import "dotenv/config";

// Import the agent-deploy module (compiled)
const agentDeploy = await import("../dist/agent-deploy.js");

const args = process.argv.slice(2);
const command = args[0] || "status";

async function testStatus() {
  console.log("=== Agent Deployment Configuration Status ===\n");

  const cursorConfig = agentDeploy.getCursorConfigFromEnv();
  const claudeConfig = agentDeploy.getClaudeAgentConfigFromEnv();
  const status = agentDeploy.getAgentStatus();

  console.log("Cursor Cloud Agents:");
  console.log(`  Configured: ${status.cursor.configured ? "Yes" : "No"}`);
  if (status.cursor.configured) {
    console.log(`  API Key: ${status.cursor.apiKey}`);
    console.log(`  Base URL: ${cursorConfig?.baseUrl || "default"}`);
    console.log(`  Default Repo: ${process.env.CURSOR_DEFAULT_REPO || "(not set)"}`);
  } else {
    console.log("  Set CURSOR_API_KEY in .env to enable");
  }

  console.log("\nClaude Agent SDK:");
  console.log(`  Configured: ${status.claude.configured ? "Yes" : "No"}`);
  if (status.claude.configured) {
    console.log(`  Model: ${claudeConfig?.model || "default"}`);
  } else {
    console.log("  Set ANTHROPIC_API_KEY in .env to enable");
  }

  // Check if claude CLI is available
  console.log("\nClaude CLI:");
  try {
    const { execSync } = await import("child_process");
    const version = execSync("claude --version 2>&1", { encoding: "utf-8" }).trim();
    console.log(`  Installed: Yes (${version.split("\n")[0]})`);
  } catch {
    console.log("  Installed: No");
    console.log("  Install with: npm install -g @anthropic-ai/claude-code");
  }

  console.log("\n=== Voice Command Patterns ===\n");
  console.log("Cursor agent triggers:");
  console.log('  - "cursor agent [task]"');
  console.log('  - "deploy cursor [task]"');
  console.log('  - "cursor cloud [task]"');
  console.log('  - "background agent [task]"');

  console.log("\nClaude agent triggers:");
  console.log('  - "claude agent [task]"');
  console.log('  - "claude code agent [task]"');
  console.log('  - "deploy claude [task]"');
  console.log('  - "run claude code [task]"');
}

async function testParse(input) {
  console.log(`\n=== Parsing: "${input}" ===\n`);
  const result = agentDeploy.parseAgentCommand(input);
  console.log("Is Agent Command:", result.isAgentCommand);
  if (result.request) {
    console.log("Agent Type:", result.request.type);
    console.log("Prompt:", result.request.prompt);
    console.log("Request:", JSON.stringify(result.request, null, 2));
  }
}

async function testDeployCursor(prompt) {
  console.log(`\n=== Deploying Cursor Agent ===\n`);
  console.log(`Prompt: "${prompt}"`);

  const config = agentDeploy.getCursorConfigFromEnv();
  if (!config) {
    console.error("Error: CURSOR_API_KEY not set");
    process.exit(1);
  }

  const repository = process.env.CURSOR_DEFAULT_REPO;
  if (!repository) {
    console.error("Error: CURSOR_DEFAULT_REPO not set");
    console.log("Set it to your GitHub repository URL, e.g.:");
    console.log("  CURSOR_DEFAULT_REPO=https://github.com/your-org/your-repo");
    process.exit(1);
  }

  console.log(`Repository: ${repository}`);
  console.log("");

  const result = await agentDeploy.deployCursorAgent(config, {
    type: "cursor",
    prompt,
    repository,
    autoCreatePr: true,
  });

  console.log("Result:");
  console.log(JSON.stringify(result, null, 2));

  if (result.success) {
    console.log(`\nAgent deployed successfully!`);
    console.log(`Agent ID: ${result.agentId}`);
    console.log(`Status: ${result.status}`);
    if (result.details?.prUrl) {
      console.log(`PR URL: ${result.details.prUrl}`);
    }
    process.exit(0);
  } else {
    console.error(`\nDeployment failed: ${result.error}`);
    process.exit(1);
  }
}

async function testDeployClaude(prompt) {
  console.log(`\n=== Deploying Claude Agent ===\n`);
  console.log(`Prompt: "${prompt}"`);
  console.log(`Working Directory: ${process.cwd()}`);
  console.log("");

  const config = agentDeploy.getClaudeAgentConfigFromEnv();
  if (!config) {
    console.error("Error: ANTHROPIC_API_KEY not set");
    process.exit(1);
  }

  console.log("Starting agent (this may take a while)...\n");

  const result = await agentDeploy.deployClaudeAgent(config, {
    type: "claude",
    prompt,
    allowedTools: ["Read", "Glob", "Grep"], // Safe read-only tools for testing
  });

  console.log("\nResult:");
  console.log(JSON.stringify(result, null, 2));

  if (result.success) {
    console.log(`\nAgent completed!`);
    console.log(`Status: ${result.status}`);
    process.exit(0);
  } else {
    console.error(`\nAgent failed: ${result.error}`);
    process.exit(1);
  }
}

async function testListCursorAgents() {
  console.log(`\n=== Listing Cursor Agents ===\n`);

  const config = agentDeploy.getCursorConfigFromEnv();
  if (!config) {
    console.error("Error: CURSOR_API_KEY not set");
    process.exit(1);
  }

  const result = await agentDeploy.listCursorAgents(config, 5);

  if (result.success) {
    console.log(`Found ${result.agents?.length || 0} agents:\n`);
    for (const agent of result.agents || []) {
      console.log(`  ${agent.id}:`);
      console.log(`    Name: ${agent.name || "(unnamed)"}`);
      console.log(`    Status: ${agent.status}`);
      console.log(`    Created: ${agent.createdAt}`);
      if (agent.summary) {
        console.log(`    Summary: ${agent.summary.slice(0, 100)}...`);
      }
      console.log("");
    }
    process.exit(0);
  } else {
    console.error(`Failed to list agents: ${result.error}`);
    process.exit(1);
  }
}

// Main
switch (command) {
  case "status":
    await testStatus();
    break;
  case "parse":
    if (!args[1]) {
      console.log("Usage: node test-agent-deploy.js parse \"voice command\"");
      console.log("\nExamples:");
      await testParse("cursor agent fix the login bug");
      await testParse("claude code refactor the auth module");
      await testParse("deploy cursor to add dark mode");
      await testParse("run claude to analyze tests");
      await testParse("just a normal question");
    } else {
      await testParse(args.slice(1).join(" "));
    }
    break;
  case "cursor":
    if (!args[1]) {
      console.log("Usage: node test-agent-deploy.js cursor \"task description\"");
      process.exit(1);
    }
    await testDeployCursor(args.slice(1).join(" "));
    break;
  case "claude":
    if (!args[1]) {
      console.log("Usage: node test-agent-deploy.js claude \"task description\"");
      process.exit(1);
    }
    await testDeployClaude(args.slice(1).join(" "));
    break;
  case "list":
    await testListCursorAgents();
    break;
  default:
    console.log("Agent Deployment Test Script\n");
    console.log("Commands:");
    console.log("  status              Check configuration status");
    console.log("  parse \"command\"     Test voice command parsing");
    console.log("  cursor \"prompt\"     Deploy a Cursor agent");
    console.log("  claude \"prompt\"     Deploy a Claude agent");
    console.log("  list                List recent Cursor agents");
    console.log("\nExamples:");
    console.log("  node scripts/test-agent-deploy.js status");
    console.log("  node scripts/test-agent-deploy.js parse \"cursor agent fix login\"");
    console.log("  node scripts/test-agent-deploy.js cursor \"Fix the authentication bug\"");
    console.log("  node scripts/test-agent-deploy.js claude \"What files are in this directory?\"");
}
