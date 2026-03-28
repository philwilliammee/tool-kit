// Security configuration for bash command execution
export const COMMAND_BLOCKLIST = [
  // System administration
  "sudo",
  "su",
  "doas",
  "systemctl",
  "service",
  "init",
  "mount",
  "umount",
  "fdisk",
  "parted",
  "mkfs",

  // Network security
  "iptables",
  "ufw",
  "firewall-cmd",
  "netfilter",

  // Package management
  "apt",
  "apt-get",
  "yum",
  "dnf",
  "pacman",
  "zypper",
  "emerge",
  "npm install -g",
  "yarn global",

  // Dangerous file operations
  "dd",
  "shred",
  "wipe",
  "srm",

  // Remote access
  "ssh",
  "scp",
  "rsync",
  "sftp",
  "ftp",

  // Process control
  "kill -9",
  "killall",
  "pkill",

  // Kernel modules
  "modprobe",
  "insmod",
  "rmmod",

  // Boot and system
  "reboot",
  "shutdown",
  "halt",
  "poweroff",
];

export const ALLOWED_BASE_PATH = "/home/ds123";

export function validateCommand(command: string): {
  valid: boolean;
  reason?: string;
} {
  // Check for blocked commands with word boundaries to avoid false positives
  const lowerCommand = command.toLowerCase();

  for (const blocked of COMMAND_BLOCKLIST) {
    // Special handling for commands that should be standalone or at word boundaries
    if (blocked === "dd") {
      // Only block if "dd" appears as a standalone command or with space/start/end boundaries
      const ddPattern = /(?:^|\s)dd(?:\s|$)/;
      if (ddPattern.test(lowerCommand)) {
        return { valid: false, reason: `Blocked command: ${blocked}` };
      }
    } else if (blocked === "kill -9") {
      // Check for exact pattern
      if (lowerCommand.includes("kill -9")) {
        return { valid: false, reason: `Blocked command: ${blocked}` };
      }
    } else {
      // For other commands, use word boundary check
      const pattern = new RegExp(
        `(?:^|\\s)${blocked.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`,
      );
      if (pattern.test(lowerCommand)) {
        return { valid: false, reason: `Blocked command: ${blocked}` };
      }
    }
  }

  // Check for dangerous patterns
  if (lowerCommand.includes("rm -rf /")) {
    return { valid: false, reason: "Dangerous recursive delete detected" };
  }

  if (lowerCommand.includes("chmod 777")) {
    return { valid: false, reason: "Dangerous permission change detected" };
  }

  return { valid: true };
}

export function validatePath(path: string): boolean {
  const resolvedPath = path.startsWith("/") ? path : `/home/ds123/${path}`;
  return resolvedPath.startsWith(ALLOWED_BASE_PATH);
}
