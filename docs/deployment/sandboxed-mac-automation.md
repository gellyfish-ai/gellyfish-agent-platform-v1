# Sandboxed macOS Automation Setup

This guide sets up an isolated macOS user for Gellyfish automation. Claude controls this sandboxed user via VNC, keeping your personal account secure.

---

## Current Progress (2025-12-29)

### Completed
- [x] Step 1: Created `gellyfish` user (standard, non-admin) via System Settings
- [x] Step 2: Screen Sharing enabled on Mac
- [x] Step 3: SSH access configured - VERIFIED
  - Added gellyfish to `com.apple.access_ssh` group
  - Set up SSH key: admin's public key → `/Users/gellyfish/.ssh/authorized_keys`
  - Permissions: .ssh=700, authorized_keys=600, owner=gellyfish:staff
- [x] Step 4: Added gellyfish to `com.apple.access_screensharing` group
- [x] Step 5: Enabled SecureToken for gellyfish (required for VNC auth)
- [x] Step 6: Started gellyfish GUI session remotely via ARD kickstart
- [x] Playwright MCP configured with Firefox + persistent profile

### Next Steps
1. Set up iPhone mirroring in the gellyfish session (with safe Apple ID)
2. Install automation MCP in gellyfish's home directory
3. Configure Claude's MCP to connect via VNC to bot session

### Lessons Learned
- SSH agent is per-terminal session - must run `ssh-add ~/.ssh/id_ed25519` in each new session
- macOS Keychain SSH integration (`--apple-use-keychain`) is unreliable with passphrase-protected keys
- SSH access requires user to be in `com.apple.access_ssh` group (not just Remote Login enabled)
- sshd is strict about permissions: .ssh=700, authorized_keys=600
- **VNC to localhost always connects to YOUR session** - must test from external device
- **Never create macOS users with `dscl`** - always use System Settings to get proper AuthenticationAuthority
- Users created via `dscl` lack AuthenticationAuthority which breaks VNC authentication
- **CRITICAL: SecureToken is required for VNC authentication on FileVault-enabled Macs**
  - Check status: `sysadminctl -secureTokenStatus gellyfish`
  - Enable it: `sudo sysadminctl -secureTokenOn gellyfish -password - -adminUser ADMIN -adminPassword -`
  - Even users created via System Settings may not get SecureToken automatically
- **Fast User Switching is blocked via VNC** - you cannot click the user menu remotely
- **To start a user's GUI session remotely without physical access**, use ARD kickstart:
  ```bash
  sudo /System/Library/CoreServices/RemoteManagement/ARDAgent.app/Contents/Resources/kickstart \
    -activate -configure -access -on -users gellyfish -privs -all -restart -agent
  ```

### Configuration Notes
- VNC already working for admin user
- No MDM on this Mac
- Goal: Full Mac GUI control + iPhone mirroring in sandboxed environment
- Playwright MCP config: `~/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/playwright/.mcp.json`

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      Your Mac                            │
├─────────────────────────────────────────────────────────┤
│  admin (admin)             │  gellyfish (standard)      │
│  ├── Your files            │  ├── Automation workspace  │
│  ├── Your keychain         │  ├── Safe Apple ID         │
│  └── Your apps             │  └── iPhone mirrored here  │
│                            │                             │
│  YOU control this          │  CLAUDE controls this      │
│                            │  via VNC + automation MCP  │
└─────────────────────────────────────────────────────────┘
```

## Prerequisites

- macOS Sequoia 15+ (for iPhone mirroring)
- iOS 18+ on the iPhone
- A "safe" Apple ID for the automation account
- Spare iPhone (optional but recommended)

## Step 1: Create the Automation User

```bash
# Run as admin (your account)
sudo dscl . -create /Users/gellyfish
sudo dscl . -create /Users/gellyfish UserShell /bin/zsh
sudo dscl . -create /Users/gellyfish RealName "Gellyfish Bot"
sudo dscl . -create /Users/gellyfish UniqueID 599
sudo dscl . -create /Users/gellyfish PrimaryGroupID 20
sudo dscl . -create /Users/gellyfish NFSHomeDirectory /Users/gellyfish

# Create home directory
sudo createhomedir -c -u gellyfish

# Set password (you'll need this for VNC)
sudo dscl . -passwd /Users/gellyfish
```

Or via System Settings (RECOMMENDED):
1. System Settings → Users & Groups
2. Click "Add User..."
3. Account type: **Standard** (NOT admin)
4. Full name: `Gellyfish Bot`
5. Account name: `gellyfish`
6. Set a strong password

### Enable SecureToken (CRITICAL for VNC on FileVault Macs)

Even users created via System Settings may not get SecureToken. **This WILL break VNC authentication.**

```bash
# Check if SecureToken is enabled
sysadminctl -secureTokenStatus gellyfish

# If DISABLED, enable it (requires admin + user passwords):
sudo sysadminctl -secureTokenOn gellyfish -password - -adminUser YOUR_ADMIN -adminPassword -
```

## Step 2: Enable Screen Sharing for the Bot User

```bash
# Add user to screensharing group (REQUIRED)
sudo dseditgroup -o edit -a gellyfish -t user com.apple.access_screensharing

# Enable Remote Management (Screen Sharing)
sudo /System/Library/CoreServices/RemoteManagement/ARDAgent.app/Contents/Resources/kickstart \
  -activate -configure -access -on \
  -users gellyfish \
  -privs -all \
  -restart -agent -menu
```

Or via System Settings:
1. System Settings → General → Sharing
2. Enable "Screen Sharing"
3. Click "i" next to Screen Sharing
4. Add `gellyfish` to allowed users

Verify group membership:
```bash
dseditgroup -o checkmember -m gellyfish com.apple.access_screensharing
# Should say "yes gellyfish IS a member..."
```

## Step 3: Enable SSH Access

```bash
# Enable Remote Login
sudo systemsetup -setremotelogin on

# Optionally restrict to specific users
sudo dseditgroup -o create -q com.apple.access_ssh
sudo dseditgroup -o edit -a gellyfish -t user com.apple.access_ssh
```

## Step 4: Start the Bot User's GUI Session

The bot user needs an active GUI session for iPhone mirroring and automation.

### Option A: ARD Kickstart (Recommended for Remote Setup)
If you don't have physical access, use ARD kickstart to start the user's session:
```bash
sudo /System/Library/CoreServices/RemoteManagement/ARDAgent.app/Contents/Resources/kickstart \
  -activate -configure -access -on -users gellyfish -privs -all -restart -agent
```

**Note:** Fast User Switching via the menu bar is BLOCKED when accessing via VNC. This is a macOS security feature. Use kickstart instead.

### Option B: Fast User Switching (Requires Physical Access)
1. System Settings → Control Center → Fast User Switching → Show in Menu Bar
2. Click your name in menu bar → Login as `gellyfish`
3. Switch back to your account
4. The bot session runs in background

### Option C: Auto-login on Boot
If this is a dedicated home server:
1. System Settings → Users & Groups → Login Options
2. Automatic login: `gellyfish`
3. Your admin account can SSH in when needed

## Step 5: Configure iPhone Mirroring (on Bot User)

Log into the `gellyfish` session and:

1. Sign into the "safe" Apple ID in System Settings
2. Connect iPhone (with same Apple ID) via USB initially
3. Enable iPhone Mirroring:
   - Click iPhone icon in Dock, or
   - Spotlight → "iPhone Mirroring"
4. Trust the connection when prompted on iPhone
5. Enable "Allow access when locked" for hands-free automation

## Step 6: Install Automation MCP

SSH into the bot user and install the automation MCP:

```bash
ssh gellyfish@localhost

# Install Node.js (if not available system-wide)
curl -fsSL https://fnm.vercel.app/install | bash
fnm install --lts

# Clone and install automation-mcp
cd ~
git clone https://github.com/ashwwwin/automation-mcp.git
cd automation-mcp
npm install
```

## Step 7: Configure Claude Code MCP

Add to your MCP config (in your admin account):

```json
{
  "mac-automation": {
    "command": "ssh",
    "args": [
      "-t",
      "gellyfish@localhost",
      "cd ~/automation-mcp && node dist/index.js"
    ]
  }
}
```

Or for VNC-based control, use a combined approach:

```json
{
  "mac-automation": {
    "command": "npx",
    "args": [
      "@anthropic/automation-mcp",
      "--vnc", "localhost:5901",
      "--user", "gellyfish"
    ]
  }
}
```

## Step 8: Set Up VNC Access for Claude

Install a VNC client that can be scripted:

```bash
# The automation MCP may handle this internally, or use:
brew install tiger-vnc
```

Connect to the bot user's session:
```bash
vncviewer localhost:5900
```

## Step 9: Security Hardening

### Restrict Bot User's Capabilities

```bash
# Prevent bot from using sudo
sudo dseditgroup -o edit -d gellyfish -t user admin

# Restrict which apps can be launched (optional)
# Use Parental Controls / Screen Time on the bot account
```

### Firewall Rules

```bash
# Only allow VNC from localhost
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add /System/Library/CoreServices/Screen\ Sharing.app
```

### Audit Logging

```bash
# Enable audit logging for the bot user
sudo touch /var/audit/gellyfish.log
# Configure auditd rules as needed
```

## Step 10: Test the Setup

1. From your terminal (as admin):
```bash
# Test SSH
ssh gellyfish@localhost "echo 'SSH works'"

# Test screen sharing
open vnc://localhost
```

2. Start Claude Code and test:
```
> Take a screenshot of the gellyfish desktop
> Open Safari in the bot session
> Show the iPhone mirroring window
```

## Directory Structure

The bot user should have a clean workspace:

```
/Users/gellyfish/
├── automation-mcp/          # MCP server
├── .config/                  # App configs
├── Desktop/                  # Screenshots land here
├── Documents/                # Automation scripts
└── .ssh/                     # For remote access if needed
    └── authorized_keys
```

## Maintenance

### Check Bot Session Status
```bash
# See if bot user has active session
who | grep gellyfish

# Check screen sharing status
sudo launchctl list | grep -i screen
```

### Restart Bot Session
```bash
# Force logout bot user
sudo launchctl bootout gui/$(id -u gellyfish)

# Log back in via Fast User Switching
```

### Update Automation MCP
```bash
ssh gellyfish@localhost "cd ~/automation-mcp && git pull && npm install"
```

## Troubleshooting

### iPhone Mirroring Not Available
- Ensure both devices on same Apple ID
- Bluetooth and WiFi must be on
- May need to re-pair via USB

### VNC Authentication Failed
This is the most common issue. Check these in order:

1. **User in screensharing group?**
   ```bash
   dseditgroup -o checkmember -m gellyfish com.apple.access_screensharing
   # If not: sudo dseditgroup -o edit -a gellyfish -t user com.apple.access_screensharing
   ```

2. **SecureToken enabled?** (CRITICAL for FileVault Macs)
   ```bash
   sysadminctl -secureTokenStatus gellyfish
   # If DISABLED: sudo sysadminctl -secureTokenOn gellyfish -password - -adminUser YOUR_ADMIN -adminPassword -
   ```

3. **AuthenticationAuthority exists?**
   ```bash
   dscl . -read /Users/gellyfish AuthenticationAuthority
   # If "No such key" - user auth is broken, may need to reset password:
   # sudo sysadminctl -resetPasswordFor gellyfish -newPassword "NewPass" -adminUser YOUR_ADMIN -adminPassword -
   ```

### VNC Connection Refused
- Check Screen Sharing is enabled
- Verify firewall allows connections
- Ensure bot user has active GUI session

### Can't Start Bot User Session Remotely
Fast User Switching is blocked via VNC. Use ARD kickstart instead:
```bash
sudo /System/Library/CoreServices/RemoteManagement/ARDAgent.app/Contents/Resources/kickstart \
  -activate -configure -access -on -users gellyfish -privs -all -restart -agent
```

### Automation Not Working
- Check accessibility permissions for automation tools
- System Settings → Privacy & Security → Accessibility
- Add relevant apps to the allowed list (as admin)

## Security Considerations

| Risk | Mitigation |
|------|------------|
| Bot escapes to admin | No sudo, not in admin group |
| Accesses your files | Separate home directory, no access to /Users/admin |
| Installs malware | Standard user can't install system apps |
| Keychain access | Separate keychain, only has "safe" credentials |
| iPhone compromise | Using burner Apple ID, not your real one |

## What Claude CAN Do (in bot session)
- Control mouse and keyboard
- Take screenshots
- Open/use installed apps
- Browse the web
- Control mirrored iPhone
- Read/write files in /Users/gellyfish/

## What Claude CANNOT Do
- Access your home folder
- Install system software
- Change system settings
- Access your keychain
- Escalate to admin
- Affect your running session
