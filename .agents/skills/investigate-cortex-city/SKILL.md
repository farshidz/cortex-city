---
name: investigate-cortex-city
description: Investigate Cortex City production issues through its local SSH tunnel. Use when diagnosing live sessions, reviews, worker behavior, logs, or other production anomalies and remote-host access is required.
---

# Investigate Cortex City

- Use the local port supplied by the user. Default to port `3001` when the user does not specify one.
- Access the production UI and API at `http://localhost:<local-port>`.
- The selected local port is an SSH tunnel to the remote Cortex City service.
- Set `cortex_city_port` to the selected local port, then find every process listening on that port. This avoids depending on how the SSH `-L` argument was written.

```bash
cortex_city_port=3001
tunnel_pids="$(lsof -nP -t -iTCP:"${cortex_city_port}" -sTCP:LISTEN | sort -u | paste -sd, -)"
if [ -z "${tunnel_pids}" ]; then
  echo "No process is listening on local port ${cortex_city_port}" >&2
  exit 1
fi
ps -p "${tunnel_pids}" -o pid=,command=
```

- Select the SSH process from the listener output. Read its full command to identify the remote `user@host` and connection-critical options such as `-p`, `-i`, `-J`, and `-F`.
- Connect with `ssh <connection-options> <user@host>`, preserving the options required to reach the same endpoint. Omit tunnel-only options such as `-L`, `-N`, and `-f` from the interactive connection.
- Keep production investigation read-only unless the user explicitly authorizes a change.

## Tunnel discovery regression matrix

Listener-to-PID discovery must locate the SSH process for each of these valid tunnel forms without parsing the `-L` argument:

| Tunnel form | Expected result |
| --- | --- |
| `ssh -L <local-port>:<target>` | Locate the listener PID and display the full command. |
| `ssh -L<local-port>:<target>` | Locate the listener PID and display the full command. |
| `ssh -L 127.0.0.1:<local-port>:<target>` | Locate the listener PID and display the full command. |
| `ssh -L '[::1]:<local-port>:<target>'` | Locate the listener PID and display the full command. |
| `ssh -p <ssh-port> -J <jump-host> -L <local-port>:<target>` | Locate the listener PID and preserve `-p` and `-J` for the interactive connection. |
