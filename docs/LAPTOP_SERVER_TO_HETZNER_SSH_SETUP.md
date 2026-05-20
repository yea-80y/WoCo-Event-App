# Setting up SSH access from laptop-server (192.168.0.144) to Hetzner

Goal: be able to run `ssh hetzner` (or `ssh root@46.225.174.72`) from the laptop-server so you can
tail Bee logs, run ops commands, etc. without having to be on this laptop.

**Security principle:** the laptop-server gets its own dedicated keypair. The private key never
leaves the laptop-server. You can revoke just that key later without touching this laptop's access.

**Do this entirely in your own terminals**, not in a Claude session — that way the public key
never enters a chat context.

---

## Step 1 — Generate a new keypair on the laptop-server

In a regular terminal on this laptop (not Claude):

```bash
ssh ntl-dev@192.168.0.144
```

Once on the laptop-server:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_hetzner -C "ntl-dev@laptop-server-to-hetzner"
```

- It asks for a passphrase: type a **strong, unique** passphrase. Don't reuse the passphrase
  from your other SSH keys.
- It asks to confirm: type the same again.

You now have two new files on the laptop-server:
- `~/.ssh/id_ed25519_hetzner` — the **private** key. Stays here forever. Permissions are
  automatically `600` (owner read/write only).
- `~/.ssh/id_ed25519_hetzner.pub` — the **public** key. Safe to share.

## Step 2 — Read the public key

Still on the laptop-server:

```bash
cat ~/.ssh/id_ed25519_hetzner.pub
```

Output will be a single line like `ssh-ed25519 AAAAC3...long-base64... ntl-dev@laptop-server-to-hetzner`.

Triple-click it in your terminal to select the whole line, then copy.

## Step 3 — Add it to Hetzner's authorized_keys

Open a **separate terminal on this laptop** (a regular shell, not the Claude one). Your laptop
already has Hetzner SSH access via the existing key.

```bash
ssh root@46.225.174.72
```

Once in:

```bash
nano /root/.ssh/authorized_keys
```

Press the down arrow to go to the bottom. Hit `Enter` to make a new blank line. Paste the public
key on that new line. The file should now have two lines — your existing laptop key on line 1,
the new laptop-server key on line 2.

Save and exit nano:
- `Ctrl+O` then `Enter` (save)
- `Ctrl+X` (exit)

Then disconnect from Hetzner:

```bash
exit
```

> Why nano instead of `echo "..." >> file`? An echo pipeline is easy to copy wrong — a single
> missing quote and you append a malformed line that can break authorized_keys parsing for
> everyone. Manual edit is safer for one-time additions.

## Step 4 — Test from the laptop-server

Back in your laptop-server SSH session:

```bash
ssh -i ~/.ssh/id_ed25519_hetzner root@46.225.174.72 'echo "hello from laptop-server" && hostname'
```

You'll be prompted for the passphrase you set in Step 1. Type it.

Expected output:

```
hello from laptop-server
woco-prod
```

If you get `Permission denied (publickey)`, the public key wasn't pasted correctly in Step 3 —
go back, `nano /root/.ssh/authorized_keys` from this laptop again, fix the line, retry.

## Step 5 — Make it the default (optional but recommended)

Saves typing `-i ~/.ssh/id_ed25519_hetzner` every time, and lets you use a short alias.

On the laptop-server:

```bash
cat >> ~/.ssh/config <<'EOF'

Host hetzner
  HostName 46.225.174.72
  User root
  IdentityFile ~/.ssh/id_ed25519_hetzner
EOF
chmod 600 ~/.ssh/config
```

Test the alias:

```bash
ssh hetzner 'hostname'
# → woco-prod
```

Now you can run any of the ops commands from `docs/HETZNER_DEPLOY.md` directly:

```bash
ssh hetzner 'cd /opt/woco && docker compose logs -f --tail 50 bee'
ssh hetzner 'cd /opt/woco && docker compose ps'
```

## Step 6 — Use ssh-agent to skip retyping the passphrase

Each terminal session will ask for the passphrase the first time you SSH. To avoid retyping
within a session, add the key to ssh-agent once:

```bash
eval "$(ssh-agent -s)"           # starts the agent for this shell
ssh-add ~/.ssh/id_ed25519_hetzner # asks for passphrase, caches it
```

Subsequent `ssh hetzner` calls in that shell won't prompt. Closing the terminal clears the cache,
which is the right trade-off for a server-class machine.

---

## When you're done, ask Claude to verify

Tell Claude: "I've added the laptop-server key, please verify Hetzner now has 2 keys."

Claude will SSH in and run `wc -l /root/.ssh/authorized_keys` + `ssh-keygen -lf /root/.ssh/authorized_keys`
to confirm there are now 2 keys, and read out the fingerprints (fingerprints are derived hashes,
not the keys themselves — safe to share). That confirms the addition worked without Claude
needing to see the new public key.

## To revoke laptop-server access later

If the laptop-server is ever compromised, retired, or you just want to clean up:

From any machine with Hetzner access:

```bash
ssh root@46.225.174.72
nano /root/.ssh/authorized_keys
# Delete the line that ends with "ntl-dev@laptop-server-to-hetzner"
# Save (Ctrl+O, Enter), exit (Ctrl+X)
exit
```

That immediately revokes laptop-server's access. Existing SSH sessions from laptop-server stay
alive but new connections are refused.
