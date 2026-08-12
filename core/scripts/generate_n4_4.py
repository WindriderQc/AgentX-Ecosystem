import json

def create_node(id, name, type, position, parameters=None, typeVersion=1):
    node = {
        "parameters": parameters or {},
        "id": id,
        "name": name,
        "type": type,
        "typeVersion": typeVersion,
        "position": position
    }
    return node

nodes = []
connections = {}

# 1. Webhook Trigger
nodes.append(create_node(
    "webhook-trigger", "Webhook Trigger", "n8n-nodes-base.webhook", [100, 300],
    {
        "path": "sbqc-n4-4-self-healing-trigger",
        "options": {},
        "httpMethod": "POST",
        "responseMode": "responseNode"
    },
    typeVersion=2
))

# 2. Extract & Validate
nodes.append(create_node(
    "extract-data", "Extract & Validate", "n8n-nodes-base.set", [300, 300],
    {
        "assignments": {
            "assignments": [
                { "name": "ruleName", "value": "={{ $json.body.ruleName }}", "type": "string" },
                { "name": "component", "value": "={{ $json.body.component }}", "type": "string" },
                { "name": "action", "value": "={{ $json.body.remediationAction }}", "type": "string" },
                { "name": "requiresApproval", "value": "={{ $json.body.requiresApproval }}", "type": "boolean" },
                { "name": "detectedIssue", "value": "={{ $json.body.detectedIssue }}", "type": "object" },
                { "name": "startTime", "value": "={{ $now }}", "type": "string" }
            ]
        }
    },
    typeVersion=3.4
))

# 3. Check Approval Required
nodes.append(create_node(
    "check-approval", "Approval Required?", "n8n-nodes-base.if", [500, 300],
    {
        "conditions": {
            "conditions": [
                {
                    "leftValue": "={{ $json.requiresApproval }}",
                    "rightValue": True,
                    "operator": { "type": "boolean", "operation": "true" }
                }
            ]
        }
    },
    typeVersion=2.1
))

# 4. Send Approval Request (Mock Slack)
nodes.append(create_node(
    "request-approval", "Request Approval (Slack)", "n8n-nodes-base.httpRequest", [700, 100],
    {
        "url": "={{$env.SLACK_WEBHOOK_URL}}",
        "method": "POST",
        "authentication": "none",
        "body": {
            "text": "Approval required for self-healing action: {{$json.action}} on {{$json.component}}"
        }
    },
    typeVersion=4.2
))

# 5. Execute Remediation (Switch)
nodes.append(create_node(
    "route-action", "Route Action", "n8n-nodes-base.switch", [700, 500],
    {
        "rules": {
            "rules": [
                { "value": "switch_to_backup_host", "output": 0 },
                { "value": "rollback_to_previous_version", "output": 1 },
                { "value": "pm2_restart_agentx", "output": 2 },
                { "value": "enable_rate_limiting", "output": 3 },
                { "value": "send_alert", "output": 4 }
            ]
        },
        "dataType": "string",
        "value1": "={{ $json.action }}"
    },
    typeVersion=3
))

# 6. Model Failover
nodes.append(create_node(
    "action-failover", "Model Failover", "n8n-nodes-base.httpRequest", [1000, 300],
    {
        "url": "http://localhost:3080/api/models/failover",
        "method": "POST",
        "authentication": "predefinedCredentialType",
        "nodeCredentialType": "httpHeaderAuth",
        "credentialId": "agentx-api-key",
        "body": { "component": "={{ $json.component }}" }
    },
    typeVersion=4.2
))

# 7. Prompt Rollback
nodes.append(create_node(
    "action-rollback", "Prompt Rollback", "n8n-nodes-base.httpRequest", [1000, 450],
    {
        "url": "http://localhost:3080/api/prompts/rollback",
        "method": "POST",
        "authentication": "predefinedCredentialType",
        "nodeCredentialType": "httpHeaderAuth",
        "credentialId": "agentx-api-key",
        "body": { "component": "={{ $json.component }}" }
    },
    typeVersion=4.2
))

# 8. Service Restart
nodes.append(create_node(
    "action-restart", "Service Restart", "n8n-nodes-base.httpRequest", [1000, 600],
    {
        "url": "http://localhost:3080/api/system/restart",
        "method": "POST",
        "authentication": "predefinedCredentialType",
        "nodeCredentialType": "httpHeaderAuth",
        "credentialId": "agentx-api-key",
        "body": { "service": "agentx" }
    },
    typeVersion=4.2
))

# 9. Throttle Requests
nodes.append(create_node(
    "action-throttle", "Throttle Requests", "n8n-nodes-base.httpRequest", [1000, 750],
    {
        "url": "http://localhost:3080/api/system/throttle",
        "method": "POST",
        "authentication": "predefinedCredentialType",
        "nodeCredentialType": "httpHeaderAuth",
        "credentialId": "agentx-api-key",
        "body": { "enabled": True }
    },
    typeVersion=4.2
))

# 10. Alert Only
nodes.append(create_node(
    "action-alert", "Alert Only", "n8n-nodes-base.httpRequest", [1000, 900],
    {
        "url": "http://localhost:3080/api/alerts",
        "method": "POST",
        "authentication": "predefinedCredentialType",
        "nodeCredentialType": "httpHeaderAuth",
        "credentialId": "agentx-api-key",
        "body": {
            "title": "Self-Healing Alert",
            "message": "Rule triggered: {{$json.ruleName}}",
            "severity": "warning",
            "source": "self-healing-workflow",
            "context": { "component": "={{$json.component}}" }
        }
    },
    typeVersion=4.2
))

# 11. Merge Results
nodes.append(create_node(
    "merge-results", "Merge Results", "n8n-nodes-base.merge", [1300, 500],
    {
        "mode": "append"
    },
    typeVersion=3
))

# 12. Update Execution Status
nodes.append(create_node(
    "update-status", "Update Status", "n8n-nodes-base.httpRequest", [1500, 500],
    {
        "url": "http://localhost:3080/api/self-healing/executions",
        "method": "POST",
        "authentication": "predefinedCredentialType",
        "nodeCredentialType": "httpHeaderAuth",
        "credentialId": "agentx-api-key",
        "body": {
            "ruleName": "={{ $json.ruleName }}",
            "action": "={{ $json.action }}",
            "status": "success",
            "startTime": "={{ $json.startTime }}",
            "endTime": "={{ $now }}"
        }
    },
    typeVersion=4.2
))

# 13. Respond to Webhook
nodes.append(create_node(
    "respond-webhook", "Respond to Webhook", "n8n-nodes-base.respondToWebhook", [1700, 500],
    {
        "respondWith": "json",
        "responseBody": "={{ JSON.stringify({ status: 'success', result: $json }) }}"
    },
    typeVersion=1.1
))

# Connections
connections = {
    "Webhook Trigger": { "main": [[{ "node": "Extract & Validate", "type": "main", "index": 0 }]] },
    "Extract & Validate": { "main": [[{ "node": "Approval Required?", "type": "main", "index": 0 }]] },
    "Approval Required?": {
        "main": [
            [{ "node": "Request Approval (Slack)", "type": "main", "index": 0 }], # True
            [{ "node": "Route Action", "type": "main", "index": 0 }]  # False
        ]
    },
    "Route Action": {
        "main": [
            [{ "node": "Model Failover", "type": "main", "index": 0 }],
            [{ "node": "Prompt Rollback", "type": "main", "index": 0 }],
            [{ "node": "Service Restart", "type": "main", "index": 0 }],
            [{ "node": "Throttle Requests", "type": "main", "index": 0 }],
            [{ "node": "Alert Only", "type": "main", "index": 0 }]
        ]
    },
    "Model Failover": { "main": [[{ "node": "Merge Results", "type": "main", "index": 0 }]] },
    "Prompt Rollback": { "main": [[{ "node": "Merge Results", "type": "main", "index": 0 }]] },
    "Service Restart": { "main": [[{ "node": "Merge Results", "type": "main", "index": 0 }]] },
    "Throttle Requests": { "main": [[{ "node": "Merge Results", "type": "main", "index": 0 }]] },
    "Alert Only": { "main": [[{ "node": "Merge Results", "type": "main", "index": 0 }]] },
    "Merge Results": { "main": [[{ "node": "Update Status", "type": "main", "index": 0 }]] },
    "Update Status": { "main": [[{ "node": "Respond to Webhook", "type": "main", "index": 0 }]] }
}

workflow = {
    "name": "SBQC - N4.4 Self-Healing Orchestrator",
    "nodes": nodes,
    "connections": connections,
    "active": True,
    "settings": {},
    "versionId": "1"
}

print(json.dumps(workflow, indent=2))
