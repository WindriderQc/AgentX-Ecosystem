# Security policy

## Supported versions

Security fixes are applied to the latest stable Agent X release. Test-channel
commits and prereleases receive fixes on a best-effort basis.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository. Do not open
a public issue containing an exploit, credential, private endpoint, personal
data, or machine inventory.

Include the affected version or commit, the smallest safe reproduction, the
expected impact, and any known workaround. Reports should use synthetic data
and localhost endpoints whenever possible.

## Deployment boundary

Agent X is designed for a private LAN. It has no built-in authentication,
authorization, or rate limiting: any client that can reach a service port can
use every route of the active profile, and services on the Compose network
trust each other. Do not expose it to the Internet without an external
authentication layer in front of it.
