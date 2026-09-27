# -*- coding: utf-8 -*-
"""SSH 执行助手：python tools/ssh_exec.py <host> <port> <user> <auth> <command...>

auth:  pw:<password> 或  key:<私钥路径>
"""
import sys
import paramiko


def connect(host, port, user, auth):
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    if auth.startswith("pw:"):
        c.connect(host, port=int(port), username=user, password=auth[3:],
                  timeout=15, allow_agent=False, look_for_keys=False)
    else:
        c.connect(host, port=int(port), username=user, key_filename=auth[4:],
                  timeout=15, allow_agent=False, look_for_keys=False)
    return c


def main():
    host, port, user, auth = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
    cmd = " ".join(sys.argv[5:]) or "echo ok"
    c = connect(host, port, user, auth)
    stdin, stdout, stderr = c.exec_command(cmd, timeout=120)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    if out.strip():
        print(out.rstrip())
    if err.strip():
        print("STDERR: " + err.rstrip(), file=sys.stderr)
    c.close()


if __name__ == "__main__":
    main()
