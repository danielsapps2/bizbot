#!/bin/bash
LABEL=com.claudebot.agent
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "ClaudeBot service removed."
