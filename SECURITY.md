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

## Product boundary

The supported default is the local-only `demo` profile. Environment-specific
extensions, remote model endpoints, and the `full` profile are trusted
operator configuration and must be reviewed and secured independently.
