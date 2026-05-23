export interface ProviderInstructions {
  provider: string;
  apexSupported: boolean;
  cnameSteps: string[];
  nsSteps?: string[];
  gotcha?: string;
}

const INSTRUCTIONS: Record<string, ProviderInstructions> = {
  Cloudflare: {
    provider: "Cloudflare",
    apexSupported: true,
    cnameSteps: [
      "Log in to dash.cloudflare.com and select your domain",
      'Click DNS in the left sidebar → Records',
      'Click Add record',
      'Type: CNAME | Name: www (or @ for root) | Target: sites.woco-net.com',
      'Proxy status: Proxied (orange cloud) ← important, enables SSL',
      'Click Save',
    ],
    gotcha: "Make sure proxy status is Proxied (orange cloud), not DNS Only — this is what issues the SSL certificate.",
  },
  GoDaddy: {
    provider: "GoDaddy",
    apexSupported: false,
    cnameSteps: [
      "Sign in → Domain Portfolio → click your domain",
      "Click DNS",
      "Click Add New Record → Type: CNAME",
      "Name: your subdomain (e.g. www or events) — not the full domain",
      "Value: sites.woco-net.com",
      "Click Save",
    ],
    nsSteps: [
      "Domain Portfolio → click domain → DNS → scroll to Nameservers",
      'Click Change → Enter my own nameservers (advanced)',
      "Delete existing entries, enter Cloudflare's two NS hostnames",
      "Click Save (may require SMS/authenticator code if Domain Protection is on)",
    ],
    gotcha: "Domain Protection requires active 2-step verification before NS changes are allowed.",
  },
  Namecheap: {
    provider: "Namecheap",
    apexSupported: false,
    cnameSteps: [
      "Log in → Domain List → Manage next to your domain",
      "Click Advanced DNS tab",
      "Click Add New Record → Type: CNAME Record",
      "Host: subdomain prefix only (e.g. www) — Namecheap appends the domain automatically",
      "Value: sites.woco-net.com",
      "Click the green checkmark to save",
    ],
    nsSteps: [
      "Domain List → Manage → Domain tab",
      "Under Nameservers, open the dropdown → select Custom DNS",
      "Replace default entries with Cloudflare's two NS hostnames",
      "Click the green checkmark",
    ],
    gotcha: "DNS records are only editable when using Namecheap BasicDNS, PremiumDNS, or FreeDNS.",
  },
  Squarespace: {
    provider: "Squarespace Domains",
    apexSupported: false,
    cnameSteps: [
      "Go to account.squarespace.com/domains → click your domain",
      "Click DNS Settings → scroll to Custom Records → click Add record",
      "Re-authenticate when prompted",
      "Type: CNAME | Name: www | Target: sites.woco-net.com",
      "Click Save",
    ],
    nsSteps: [
      "Domains dashboard → your domain → DNS → Domain Nameservers",
      "Click Use Custom Nameservers → authenticate",
      "Confirm disabling DNSSEC when prompted (required before NS change)",
      "Enter Cloudflare's two NS hostnames → Save",
    ],
    gotcha: "DNSSEC must be disabled before changing NS. Switching NS disconnects Squarespace website hosting and Google Workspace email.",
  },
  IONOS: {
    provider: "IONOS",
    apexSupported: false,
    cnameSteps: [
      "Log in → Domains & SSL",
      "Click the gear/Actions icon next to your domain → Manage Subdomains",
      "Click the gear icon next to the subdomain → DNS",
      "Click ADD RECORD → select CNAME",
      "Hostname: subdomain (e.g. www) | Point to: sites.woco-net.com",
      "Click Save",
    ],
    nsSteps: [
      "Domains & SSL → click your domain → Name Server Settings",
      "Click Use Custom Name Servers",
      "Enter Cloudflare's NS hostnames in Name Server 1–4 fields",
      "Click Save",
    ],
    gotcha: "Adding a CNAME to a subdomain removes all IONOS-managed services for that subdomain (email forwarding, FTP). This is expected.",
  },
  "AWS Route 53": {
    provider: "AWS Route 53",
    apexSupported: false,
    cnameSteps: [
      "AWS Console → Route 53 → Hosted zones → click your domain's zone",
      "Click Create record",
      "Record name: subdomain (e.g. www) | Record type: CNAME",
      "Value: sites.woco-net.com",
      "TTL: 300 (default) → click Create records",
    ],
    nsSteps: [
      "In Cloudflare, after adding your domain, copy the two assigned NS hostnames",
      "Go to your domain registrar (wherever the domain is registered, not Route 53) and update nameservers to Cloudflare's",
      "Note: Route 53 charges $0.50/month per hosted zone — you can delete the zone after switching NS",
    ],
    gotcha: "Do not edit the NS record set inside Route 53 — change NS at the domain registrar instead.",
  },
  "Name.com": {
    provider: "Name.com",
    apexSupported: false,
    cnameSteps: [
      "Log in → My Domains → click your domain",
      "Click Manage DNS Records",
      "Type: CNAME | Host: subdomain (e.g. www) | Answer: sites.woco-net.com",
      "TTL: 300 → click Add Record",
    ],
    nsSteps: [
      "My Domains → click your domain → Manage Nameservers",
      "Delete existing NS entries, enter Cloudflare's two NS hostnames",
      "Click Save",
    ],
  },
  Hover: {
    provider: "Hover",
    apexSupported: false,
    cnameSteps: [
      "Log in at hover.com → click your domain name",
      "Click the DNS tab → Add a record",
      "Type: CNAME | Hostname: subdomain (e.g. www) | Target Name: sites.woco-net.com",
      "Click Add Record",
    ],
    nsSteps: [
      "Hover dashboard → your domain → DNS tab → Edit Nameservers",
      "Replace default entries with Cloudflare's two NS hostnames (minimum 2 required)",
      "Click Save",
    ],
  },
  Porkbun: {
    provider: "Porkbun",
    apexSupported: false,
    cnameSteps: [
      "Log in → Domain Management → Details next to your domain",
      "Click the DNS/edit icon → Add Record",
      "Type: CNAME | Host: subdomain (e.g. www) | Answer: sites.woco-net.com",
      "Click Add",
    ],
    nsSteps: [
      "Domain Management → Details → click the edit icon next to Nameservers",
      "Delete existing entries, enter Cloudflare's NS hostnames (one per line)",
      "Click Submit → confirm with second Submit",
    ],
    gotcha: "Porkbun blocks adding a CNAME if an A or AAAA record already exists for the same subdomain — delete the conflicting record first.",
  },
  OVHcloud: {
    provider: "OVHcloud",
    apexSupported: false,
    cnameSteps: [
      "Log in to OVH Control Panel → Web Cloud → Domain names → your domain",
      "Click the DNS zone tab → Add an entry → select CNAME",
      "Subdomain: your subdomain (e.g. www)",
      "Target: sites.woco-net.com. ← trailing dot is required",
      "Click Next → Confirm",
    ],
    nsSteps: [
      "Control Panel → Web Cloud → Domain names → your domain",
      "Click DNS servers tab → Modify DNS servers",
      "Delete existing entries, enter Cloudflare's NS hostnames",
      "Click Apply configuration",
    ],
    gotcha: "The trailing dot is mandatory on CNAME targets in OVH. Without it, the target is treated as a subdomain of your own zone.",
  },
  Gandi: {
    provider: "Gandi",
    apexSupported: false,
    cnameSteps: [
      "Log in to admin.gandi.net → Domain → your domain",
      "Click DNS records tab → Add",
      "Type: CNAME | Name: subdomain (e.g. www) | Hostname: sites.woco-net.com",
      "Click Create",
    ],
    nsSteps: [
      "Gandi admin → your domain → Nameservers tab",
      "Click the External option",
      "Enter Cloudflare's NS hostnames → Save",
    ],
    gotcha: "Switching to external NS disables Gandi's LiveDNS editor. Set up records at Cloudflare before switching.",
  },
  "123-reg": {
    provider: "123-reg",
    apexSupported: false,
    cnameSteps: [
      "Log in to 123-reg Control Panel → Domain Portfolio",
      "Select your domain → click DNS in the toolbar",
      "Add New Record → Type: CNAME",
      "Hostname: subdomain (e.g. www) | Value: sites.woco-net.com | TTL: 3600",
      "Click Save",
    ],
    nsSteps: [
      "Domain Portfolio → DNS → Nameservers → Change Nameservers",
      "Select I'll use my own nameservers",
      "Enter Cloudflare's NS hostnames → Save",
    ],
    gotcha: "123-reg is owned by GoDaddy Group. Some accounts may show a GoDaddy-style interface.",
  },
  "One.com": {
    provider: "One.com",
    apexSupported: false,
    cnameSteps: [
      "Log in to One.com Control Panel → Advanced settings → DNS settings",
      "Click DNS records tab → under Create new record, click CNAME",
      "Hostname: subdomain (e.g. www) | Domain name (alias of): sites.woco-net.com",
      "Click Create record",
    ],
    nsSteps: [
      "Control Panel → Advanced settings → DNS settings → Name servers tab",
      "Select Change to custom name servers",
      "Enter Cloudflare's NS hostnames → Save",
    ],
  },
  Strato: {
    provider: "Strato",
    apexSupported: false,
    cnameSteps: [
      "Log in at strato.de → Domains → Domain management",
      "Click the cogwheel next to your domain → DNS tab",
      "Find the row for your subdomain → click manage in the CNAME column",
      "Enter sites.woco-net.com. ← trailing dot required",
      "Tick the confirmation checkbox",
      "Click Accept settings",
    ],
    nsSteps: [
      "Log in → Domains → your domain → Nameservers section",
      "Switch to External nameservers",
      "Enter Cloudflare's NS hostnames → Save",
    ],
    gotcha: "Trailing dot required. Enabling a CNAME removes all Strato-managed services (email, FTP) for that subdomain. Strato UI is primarily German.",
  },
  Fasthosts: {
    provider: "Fasthosts",
    apexSupported: false,
    cnameSteps: [
      "Log in to Fasthosts account → Domain Names in left menu",
      "Click the DNS icon next to your domain",
      "Scroll to CNAME Records → Add CNAME Record",
      "Host Name: subdomain (e.g. www) | Points To: sites.woco-net.com",
      "Click Save",
    ],
    nsSteps: [
      "Log in → Domain Names → select domain",
      "Click Nameservers and glue records",
      "Select custom/external nameservers option",
      "Enter Cloudflare's NS hostnames → Save",
    ],
    gotcha: "Fasthosts UI has been redesigned multiple times — the DNS section may be under 'Advanced DNS' in older accounts. Allow up to 72 hours for NS propagation.",
  },
  "Network Solutions": {
    provider: "Network Solutions",
    apexSupported: false,
    cnameSteps: [
      "Log in → My Account → Domains → your domain",
      "Scroll to Advanced Tools → Manage next to Advanced DNS Records",
      "Add Record → Type: CNAME (Alias) | Refers to: Other Host",
      "Alias: subdomain (e.g. www) | Host Name: sites.woco-net.com",
      "Click Continue → Save Changes",
    ],
    nsSteps: [
      "My Account → Domains → your domain",
      "Advanced Tools → Manage next to Nameservers (DNS)",
      "Delete existing NS entries, enter Cloudflare's NS hostnames → Save",
    ],
    gotcha: "Network Solutions calls CNAME records 'Alias' — the Refers to field must be set to Other Host for an external target.",
  },
  DreamHost: {
    provider: "DreamHost",
    apexSupported: false,
    cnameSteps: [
      "Log in to panel.dreamhost.com → Domains → Manage Domains",
      "Click DNS below your domain → Add Record",
      "Hover over CNAME Record section → click ADD",
      "Host: subdomain (e.g. www) | Points to: sites.woco-net.com",
      "Click Add Record",
    ],
    nsSteps: [
      "Panel → Manage Websites → three-dot menu → DNS Settings",
      "Nameservers section → Change → I'll use my own nameservers",
      "Enter Cloudflare's NS hostnames → Save",
    ],
    gotcha: "'You already have a record for this name' error means a conflicting A or CNAME exists — delete it first.",
  },
  Bluehost: {
    provider: "Bluehost",
    apexSupported: false,
    cnameSteps: [
      "Log in → Hosting → your domain → Manage → DNS tab",
      "Under CNAME section → Add record",
      "Host Record: subdomain (e.g. www) | Type: CNAME | Points To: sites.woco-net.com",
      "Click Add Record",
    ],
    nsSteps: [
      "Dashboard → Domains → Manage → DNS tab → Nameservers",
      "Switch to Custom Nameservers → enter Cloudflare's NS → Save",
    ],
    gotcha: "Bluehost has two DNS paths — the simplified Domains panel and full cPanel Zone Editor. Either works.",
  },
  HostGator: {
    provider: "HostGator",
    apexSupported: false,
    cnameSteps: [
      "Log in to cPanel (yourdomain.com/cpanel) → Domains → Zone Editor",
      "Manage next to your domain → Add Record",
      "Type: CNAME | Name: subdomain.yourdomain.com | Record: sites.woco-net.com",
      "Click Add Record",
    ],
    nsSteps: [
      "Log in → Domains → your domain → Manage → DNS/Nameservers",
      "Switch to Custom Nameservers → enter Cloudflare's NS → Save",
    ],
  },
  "Heart Internet": {
    provider: "Heart Internet",
    apexSupported: false,
    cnameSteps: [
      "Log in to Heart Internet Control Panel",
      "Domain names (right-hand menu under Manage) → select domain → Manage Now",
      "Click DNS Management",
      "Under Create New A/AAAA/CNAME Records:",
      "Subdomain: your subdomain (e.g. www) | Address: sites.woco-net.com. ← trailing dot required",
      "Click Update DNS",
    ],
    nsSteps: [
      "Control Panel → Domain names → your domain → Manage Now → click nameservers",
      "Replace existing entries with Cloudflare's NS hostnames → Save",
    ],
    gotcha: "Trailing dot is required on the CNAME target.",
  },
  "Hetzner DNS": {
    provider: "Hetzner DNS",
    apexSupported: false,
    cnameSteps: [
      "Log in to console.hetzner.com → DNS → click your zone",
      "Click Records tab → Type: CNAME",
      "Name: subdomain (e.g. www) | Value: sites.woco-net.com. ← trailing dot required",
      "Set TTL → click Add record",
    ],
    nsSteps: [
      "Go to your domain registrar (Hetzner DNS ≠ your registrar unless you registered there)",
      "Change NS to Cloudflare's two NS hostnames",
      "Hetzner DNS zone can then be deleted or left unused",
    ],
    gotcha: "Trailing dot is mandatory — without it, Hetzner appends the current zone name.",
  },
};

const GENERIC: ProviderInstructions = {
  provider: "Unknown",
  apexSupported: false,
  cnameSteps: [
    "Log in to your DNS provider's control panel",
    "Find the DNS records section for your domain",
    "Add a new CNAME record:",
    "  Type: CNAME (sometimes called 'Alias')",
    "  Name / Host: your subdomain (e.g. www — not the full domain)",
    "  Target / Value / Points to: sites.woco-net.com",
    "Save the record",
  ],
};

export function getProviderInstructions(provider: string): ProviderInstructions {
  return INSTRUCTIONS[provider] ?? GENERIC;
}
