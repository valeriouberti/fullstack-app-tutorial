# Local EKS + ArgoCD rehearsal plan

Goal: reproduce the logical flow of the diagram (User → CloudFront → ALB → EKS) end-to-end
on your laptop, with a real CI/CD + GitOps loop, before touching Terraform/AWS. Database is
out of scope. CloudFront/ALB are not reproduced — minikube's ingress plays that role locally.

## How the diagram maps to the local setup

| Diagram element | Local stand-in |
|---|---|
| EKS              | minikube (single-node Kubernetes cluster) |
| ALB / CloudFront | minikube `ingress` addon (NGINX) — skip in v1, use `kubectl port-forward` first |
| Two EKS boxes    | `frontend` and `backend` Deployments in the cluster |
| (CI/CD, not in diagram) | GitHub Actions — builds & pushes images |
| (GitOps, not in diagram) | ArgoCD — watches this repo's Helm charts, syncs cluster to match them |

## Prerequisites to install

- Docker Desktop (minikube's driver)
- `minikube`
- `kubectl`
- `helm` (chart authoring/templating — ArgoCD renders these charts itself, but `helm template`/
  `helm lint` locally is how you'll debug them)
- `git` + a GitHub account (repo will be pushed there per your choice)
- optional: `argocd` CLI (nice for debugging but not required — the ArgoCD UI/`kubectl` are
  enough)

## Repo layout (monorepo, per your choice)

```
full-stack-app/
├── frontend/                  # existing Vite app
├── backend/                   # existing Go app
├── charts/                    # NEW — Helm charts ArgoCD watches
│   ├── backend/
│   │   ├── Chart.yaml
│   │   ├── values.yaml        # image.repository, image.tag, replicaCount, etc.
│   │   └── templates/
│   │       ├── deployment.yaml
│   │       └── service.yaml
│   └── frontend/
│       ├── Chart.yaml
│       ├── values.yaml
│       └── templates/
│           ├── deployment.yaml
│           ├── service.yaml
│           └── ingress.yaml   # templated, disabled via values until Ingress phase
├── .github/workflows/
│   └── ci.yaml                # NEW — build/push images, bump values.yaml tags
├── Dockerfile (in frontend/ and backend/)
```

One chart per app rather than a single umbrella chart with subcharts — two services is small
enough that independent charts stay simple, and each gets its own ArgoCD `Application` (see
Phase 6).

## Phase 0 — get the code into git

1. `git init`, commit current `frontend/` + `backend/` code.
2. Create a GitHub repo, push `main`.
3. ArgoCD will later point at this same repo/branch, path `charts/<app>`.

## Phase 1 — containerize the apps

- `backend/Dockerfile`: multi-stage Go build → tiny `scratch`/`distroless` runtime image.
- `frontend/Dockerfile`: `npm run build` → static files served by `nginx` (or `vite preview`,
  but nginx is closer to how you'd run it in EKS).
- Verify both build and run locally with plain `docker run` before involving Kubernetes at all
  — cheapest place to catch bugs.

## Phase 2 — image distribution: GHCR (decided)

minikube runs its own Docker daemon/VM — it can't see images you build on your host unless you
hand them over. Decision: push to **GHCR** (GitHub Container Registry) rather than
`minikube image load`, so the CI→CD loop is real (CI actually publishes an artifact that the
cluster pulls) instead of a local-only shortcut that ArgoCD can't trigger.

- **Image naming**: `ghcr.io/<github-username>/<app>:<tag>` — e.g.
  `ghcr.io/valerio.../backend:<commit-sha>`, tag = commit SHA (not `latest`) so every deploy is
  traceable to a specific commit and `values.yaml` diffs are meaningful in git history.
- **Auth from CI**: GitHub Actions authenticates to GHCR with the automatically-provided
  `GITHUB_TOKEN` (needs `packages: write` permission set on the workflow/job) — no extra PAT or
  secret to create.
- **Auth for minikube to pull**: GHCR packages default to **private**. Either:
  - make the two packages (`backend`, `frontend`) public after the first push (simplest for a
    local training setup — no pull secret needed), or
  - keep them private and create a Kubernetes `imagePullSecret` in the cluster from a GitHub PAT
    with `read:packages`, referenced from each chart's `values.yaml`
    (`imagePullSecrets: [...]`).
  Default to public packages for now; revisit private + pull secret when this setup starts
  looking like the real AWS one (ECR is private-by-default there anyway).
- **Later, on real AWS**: swap `ghcr.io/...` for the ECR repository URI — everything else
  (CI login step, tag-by-SHA convention, `values.yaml` field) stays the same shape.

## Phase 3 — Helm charts

For each app, a small chart with:
- `templates/deployment.yaml` — 1 replica, image repo/tag pulled from `.Values.image.*`
- `templates/service.yaml` — `ClusterIP`, port pulled from `.Values.service.port`
- `templates/ingress.yaml` — present but gated behind `.Values.ingress.enabled: false` for now,
  so the template exists without being active until the Ingress phase
- `values.yaml` — the one file CI will edit to roll out new builds (`image.tag`)

Validate each chart renders sane YAML before ArgoCD ever sees it: `helm lint charts/backend`
and `helm template charts/backend | kubectl apply --dry-run=client -f -`.

No Ingress activated yet — first pass, reach services via `kubectl port-forward` to prove the
cluster + ArgoCD wiring works before adding routing complexity.

## Phase 4 — start the cluster

```
minikube start
```

Single node is enough to stand in for EKS here — we're rehearsing the GitOps workflow, not
cluster topology.

## Phase 5 — install ArgoCD

Install into a dedicated `argocd` namespace (standard official manifest install). Access the
ArgoCD UI via `kubectl port-forward svc/argocd-server -n argocd 8080:443`.

## Phase 6 — define the ArgoCD Applications

One `Application` resource per chart (two total), each with:
- `repoURL`: your GitHub repo
- `path`: `charts/backend` (or `charts/frontend`)
- `targetRevision`: `main`
- `source.helm`: ArgoCD renders the chart itself (it has a built-in Helm engine — no `helm`
  CLI needed at sync time, just the chart structure)
- `syncPolicy`: automated (so pushes to `main` auto-deploy — no manual `argocd sync` needed)

This is the actual GitOps contract: ArgoCD's job is only to make the cluster match what
`helm template` on `charts/<app>` at the pinned `values.yaml` would produce.

## Phase 7 — CI workflow (GitHub Actions)

On push to `main` (or on PR merge):
1. Build frontend + backend Docker images.
2. Push to GHCR, tagged with the commit SHA.
3. Update `image.tag` in `charts/<app>/values.yaml` and commit that change back to `main`
   (a small `yq -i '.image.tag = "..."' charts/backend/values.yaml` + `git commit && git push`,
   or the ArgoCD Image Updater add-on if you want to skip the "CI commits back to the repo"
   pattern — it edits the value in-cluster/in-git for you).

Step 3 is what actually closes the loop — ArgoCD only reacts to changes in the manifests repo,
not to new images existing in the registry.

## Phase 8 — verify the loop end-to-end

1. Change something visible in `frontend/src/App.tsx`, push to `main`.
2. Watch GitHub Actions build + push + bump the tag.
3. Watch ArgoCD (UI or `kubectl get application -n argocd`) detect drift and auto-sync.
4. `kubectl port-forward` the frontend service, confirm the change is live in the cluster.

## Open decisions before implementing (flagging now, not deciding for you)

- **Image tag bump strategy**: CI commits directly back to `main` (simpler, but is a bot commit
  in your history) vs. ArgoCD Image Updater (cleaner history, one more component to install and
  learn).
- **Ingress now or later**: port-forward is enough to prove the pipeline; add the ingress
  addon + `Ingress` resource once the GitOps loop is confirmed working, so the two concerns
  (GitOps wiring vs. routing) aren't debugged at the same time.
- **Secrets/config**: none needed yet since there's no database, but note it for when one
  appears (Sealed Secrets or ArgoCD's own secret handling, not plain Secret YAML in git).
- **Two Applications vs. App-of-Apps**: two standalone ArgoCD `Application` resources (one per
  chart) is simplest for two services; an "app-of-apps" parent chart that manages both is worth
  introducing once there are enough services that clicking around per-Application gets tedious
  — not needed yet.

## What carries over to the real AWS setup later

- Charts are ~unchanged (swap `image.repository` to point at ECR, add resource
  requests/limits sized for real traffic, add a `values-prod.yaml` overlay).
- ArgoCD `Application` config is unchanged except `repoURL` (same repo) and which values file
  it points at — this is one of Helm's actual payoffs here: `values.yaml` (local/minikube) vs.
  `values-prod.yaml` (EKS) can diverge on replica count, resources, and ingress class without
  touching the templates at all.
- CI workflow is unchanged except the registry push target.
- New at that point: Terraform for VPC/EKS/ECR/ALB/CloudFront, IAM for CI to push to ECR,
  and swapping minikube's ingress for the real ALB (likely via the AWS Load Balancer
  Controller, referenced through the chart's `ingress.className`).
