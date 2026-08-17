---
name: investigate-cortex-city
description: Investigate Cortex City production issues through its local SSH tunnel. Use when diagnosing live sessions, reviews, worker behavior, logs, or other production anomalies and remote-host access is required.
---

# Investigate Cortex City

- Use the local port supplied by the user. Default to port `3001` when the user does not specify one.
- Access the production UI and API at `http://localhost:<local-port>`.
- The selected local port is an SSH tunnel to the remote Cortex City service.
- Set `cortex_city_port` to the selected local port, then find the tunnel's remote `user@host` from the running process:

```bash
cortex_city_port=3001
ps ax -o pid=,command= | rg "[s]sh .* -L ${cortex_city_port}:"
```

- Connect with `ssh <user@host>`. Keep production investigation read-only unless the user explicitly authorizes a change.
