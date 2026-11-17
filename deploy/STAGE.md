# Safiri Demo 2: stage script

About 20 minutes. Every command is run from the project root, in a
terminal with a large font. Numbers in this file were measured on the
ThinkPad on Mon 16 Nov 2026.

## Before you walk on

After any reboot, run `deploy/up.sh` FIRST: Docker is not enabled at boot and starts only when first used. Then `deploy/preflight.sh`; if only "Anthropic API is reachable" fails right after Docker started, run it again before concluding anything.
Never `kubectl get` or `describe` the Secret, or use `-o yaml` on it, in front of the audience: the key is in the Secret and in its last-applied annotation.

1. Close VS Code and every Chrome tab except Safiri. Stop the four
   auto-restart Docker containers (ttcloud-postgres, rptw-postgres,
   altar-postgres, registry).
2. `deploy/up.sh` (about 35 s when the cluster was only stopped).
3. `deploy/preflight.sh` must end with a green `READY` (about 13 s).
4. In the stage terminal:

   ```bash
   export KUBECONFIG=deploy/kubeconfig.yaml
   kubectl config set-context --current --namespace=safiri
   ```

   This changes only `deploy/kubeconfig.yaml`. Your other kube contexts
   are untouched. The commands below assume it.
5. Open http://127.0.0.1:8080/ and let the opening play.

The only thing Safiri needs from the network is the Anthropic API.

## 1. The cluster (1 min)

```bash
kubectl get pods -o wide
```

Say: seven pods. One host, one gateway, three MCP servers (bookings twice),
one Redis. Same Safiri as Demo 1, same code, now in Kubernetes.

## 2. A normal turn (4 min)

In Safiri, click **Diani trip**.

Point at: the startup rows now say `http` and a `gateway:8080` address for
all three servers. Two tool calls, both allowed. Claude notices the odd
instruction in the Coral Breeze review and ignores it.

The flow strip shows Flights and Hotels as "HTTP, in a pod" and Bookings
as "HTTP, 2 pods", behind the gateway band. Under the toolbar, the policy
card lists the five tools from the ConfigMap and the bookings card lists
what is in Redis.

## 3. Kill a pod (4 min)

```bash
kubectl get pods -l app=bookings
kubectl delete pod <one of the two bookings pods> --wait=false
kubectl get pods -l app=bookings
```

Then in Safiri, press **Reset** and type:

> Book flight KF101 with hotel DIA-GALU for 2 nights. I confirm, book it now.

Say: one bookings pod is gone, a new one is already starting, and the
booking went through. Bookings live in Redis, not in the pod, and the
gateway opens a fresh connection for every call and retries once if the
connection fails.

Measured: 196 calls in 25 s while a pod was deleted, 0 errors. That is a
measurement, not a guarantee: do not promise that a call can never fail.

## 4. The same booking twice (4 min)

Press **Reset** (a fresh conversation, so Claude does not remember) and
send the same sentence again. The booking id in the answer is the same as
in step 3.

```bash
kubectl exec deploy/redis -- redis-cli keys 'booking:*'
kubectl logs -l app=bookings --prefix --tail=20 | grep -E 'booked|repeat'
```

Say: one key, one booking. The second request was answered with the
first booking: same flight, same hotel, same nights within 10 minutes is
the same trip. Two replicas cannot both win, because Redis decides.

## 5. Change the policy, live (4 min)

Show the list, then remove one line:

```bash
kubectl get configmap policy -o jsonpath='{.data.policy\.txt}'
grep -v book_trip deploy/k8s/policy-configmap.yaml | kubectl apply -f -
```

(or `kubectl edit configmap policy` and delete the `book_trip` line)

Wait until both pods have the new list. It takes about 5 to 10 seconds,
so talk for 15 s, or watch it arrive:

```bash
kubectl exec deploy/gateway -- cat /policy/policy.txt
```

When `book_trip` is gone from that list, the file has arrived. The policy
card on the page shows the same change: `book_trip` turns red and is
struck through. In Safiri, press **Reset** and send the booking sentence
again. The policy row is red:

    Tool 'book_trip' is not on the host's allow-list, so it was not run.

Say: no rebuild, no restart, no new image. The searches still work.

Put it back:

```bash
kubectl apply -f deploy/k8s/policy-configmap.yaml
```

If the new list has not arrived after 20 s, use the fallback (about 25 s):

```bash
kubectl rollout restart deploy/gateway deploy/host
```

Restarting the host clears the conversation and replays the startup.

## 6. Close

> The code decides how to check. The config decides what's allowed.

Press **K** for the closing card.

## If time runs out, cut in this order

1. Step 5's live wait: use the restart line instead.
2. The gateway story: keep Redis, the HTTP servers and the pod kill.
3. Step 4, the repeated booking.

## If something breaks

| What you see | Do this |
|---|---|
| Safiri does not load | `deploy/preflight.sh`, follow the first red line |
| A turn fails with an API error | the network: Safiri needs the Anthropic API |
| Bookings refuse everything | `kubectl exec deploy/redis -- redis-cli ping` |
| Booking is denied before step 5 | `kubectl apply -f deploy/k8s/policy-configmap.yaml`, wait 15 s |
| Everything is odd | `deploy/down.sh` then `deploy/up.sh` (under a minute) |

## After the last rehearsal

`deploy/down.sh`. It stops the cluster and keeps the images inside the
node. Do not use `--delete` before the talk.
