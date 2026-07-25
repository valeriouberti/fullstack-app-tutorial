# Learning guide: build this yourself, phase by phase

This is the companion to `LOCAL_GITOPS_PLAN.md`, written as a tutorial instead of a spec. For
each phase: the concept you need to understand, what to try building yourself, how to check
you got it right, and where to read more if you get stuck. No finished code here on purpose —
you write it, I review/unblock.

Suggested order of learning, if any of these are new to you: Docker → Kubernetes core objects
→ Helm → minikube → GitOps/ArgoCD → CI. Each layer assumes the one before it. If you already
know Docker/K8s basics, skip straight to whichever phase is new.

---

## Phase 1 — Containerize the apps

**Concept**: a container image is your app + everything it needs to run, minus the kernel.
"It works on my machine" stops being a problem because the machine ships with the app. A
`Dockerfile` is the recipe for building that image, layer by layer.

**Key idea to understand before writing anything**: multi-stage builds. Stage 1 has the full
toolchain (Go compiler, or `node`/`npm`) and produces a binary or static files. Stage 2 starts
from a near-empty base image and copies *only* that output in. This is why a Go binary can ship
in a ~10MB image instead of a ~1GB one with the whole Go toolchain baked in.

**Try building yourself**:
1. Write `backend/Dockerfile`: one stage with a Go base image to `go build` the binary, a
   second `FROM scratch` (or `distroless`) stage that just `COPY`s the binary and sets the
   `ENTRYPOINT`.
2. Write `frontend/Dockerfile`: one stage with a Node base image to run `npm ci && npm run
   build` (produces static files in `dist/`), a second stage `FROM nginx` that copies `dist/`
   into nginx's html folder.
3. Build both: `docker build -t backend:local ./backend` and same for frontend.
4. Run both with plain `docker run -p 8080:8080 backend:local` — no Kubernetes yet. Confirm
   `curl localhost:8080/api/health` works before adding any orchestration on top.

**Checkpoint**: `docker images` shows both, `docker run` + `curl`/browser works for each in
isolation.

**Common pitfalls**: forgetting `EXPOSE`/matching ports between `docker run -p` and what the
app actually listens on; frontend container needs nginx configured to serve `index.html` for
all routes if you ever add client-side routing (not needed yet with one page, but good to
know why it'll bite later).

**Read more**: Docker's own "multi-stage builds" guide — https://docs.docker.com/build/building/multi-stage/

---

## Phase 2 — Push images to GHCR

**Concept**: a registry is just a place to store and version images by tag, so anything (your
laptop, a CI runner, a Kubernetes node) can pull the exact same bytes by name. This is what
makes "build once, run anywhere" real instead of aspirational.

**Try yourself**:
1. Create a GitHub **Personal Access Token** (classic, scope `write:packages`) or use `gh auth
   token` if you're already logged in via the `gh` CLI.
2. `docker login ghcr.io -u <your-username>` using that token as the password.
3. Tag an image you built in Phase 1: `docker tag backend:local ghcr.io/<you>/backend:test`.
4. `docker push ghcr.io/<you>/backend:test`.
5. Go to your GitHub profile → Packages tab, find it, and change visibility to **public** (so
   minikube can pull it without needing a Kubernetes pull secret).

**Checkpoint**: the image shows up under github.com/<you>?tab=packages, and `docker pull
ghcr.io/<you>/backend:test` works from a clean state (e.g. after `docker rmi` locally).

**Common pitfalls**: token scope too narrow (needs `write:packages` to push); forgetting the
image name in the tag must start with `ghcr.io/<your-username-or-org>/...` exactly, case
matters.

**Read more**: GitHub's GHCR docs — https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry

---

## Phase 3 — Kubernetes core objects (before Helm)

**Concept**: understand the three objects you'll template with Helm, by writing one plain YAML
file by hand first — templating something you don't understand yet just hides the problem.

- **Deployment**: describes *desired state* for a set of pod replicas (which image, how many
  copies, resource limits). Kubernetes' control loop continuously reconciles reality to match
  this spec — kill a pod and it respawns, that's the whole point.
- **Service**: a stable network identity (`ClusterIP`) in front of a set of pods, selected by
  label. Pods are ephemeral (new IP every restart); Services are not.
- **Ingress**: routes external HTTP traffic into Services based on host/path rules — this is
  your local stand-in for the ALB in the diagram.

**Try yourself**:
1. By hand, write one `Deployment` YAML for the backend (`kubectl explain deployment.spec` is
   your friend for field names) and apply it directly: `kubectl apply -f backend-deployment.yaml`.
2. Write a matching `Service` YAML, apply it, and reach the pod via `kubectl port-forward
   svc/backend 8080:8080`.
3. Delete a pod manually (`kubectl delete pod <name>`) and watch `kubectl get pods -w` — a new
   one appears without you doing anything. This is the core K8s concept to internalize.

**Checkpoint**: you can explain, without looking anything up, why a Service exists when a
Deployment already has pod IPs.

**Read more**: Kubernetes docs, "Workloads" and "Services" concepts —
https://kubernetes.io/docs/concepts/workloads/controllers/deployment/ and
https://kubernetes.io/docs/concepts/services-networking/service/

---

## Phase 4 — Helm

**Concept**: Helm turns the YAML you just hand-wrote into a template with placeholders
(`{{ .Values.image.tag }}`), plus a `values.yaml` holding the actual values. The payoff:
changing an image tag or replica count becomes a one-line value edit instead of hand-editing
YAML, and different environments (local vs. prod) can reuse the same templates with different
values files.

**Try yourself**:
1. `helm create charts/backend` — this scaffolds a full example chart. Read every generated
   file before deleting anything; it's the best reference you'll have.
2. Strip it down to what you actually need (you don't need HPA, ServiceAccount, etc. yet —
   delete what you don't understand rather than leaving it as unexplained cruft).
3. Convert the Deployment/Service YAML from Phase 3 into templates, replacing hardcoded values
   (image tag, replica count, port) with `{{ .Values.xxx }}` references, and add those keys to
   `values.yaml`.
4. Render without installing anything: `helm template charts/backend` — read the output, confirm
   it's identical in shape to what you hand-wrote in Phase 3.
5. `helm install backend charts/backend` against your local cluster (once minikube is up in
   Phase 5), then `helm upgrade` after changing a value, and watch the rollout.

**Checkpoint**: you can change `values.yaml`'s `image.tag` and `replicaCount`, run `helm
upgrade`, and correctly predict what changes in `kubectl get pods` before running it.

**Common pitfalls**: forgetting `{{- end }}` on a range/if block (Helm's Go template syntax
errors are notoriously unhelpful — `helm template` locally before ever touching a real cluster
so you're not debugging templating and cluster state at once).

**Read more**: Helm's own chart template guide —
https://helm.sh/docs/chart_template_guide/getting_started/

---

## Phase 5 — minikube

**Concept**: minikube runs a real single-node Kubernetes control plane + kubelet inside a VM or
container on your machine. It's not a simulation of Kubernetes APIs — it *is* Kubernetes,
just small. This is why manifests written against it transfer to EKS almost unchanged.

**Try yourself**:
1. `minikube start`, then `kubectl get nodes` — notice it's a real `Ready` node.
2. `minikube dashboard` — a visual view of everything you've been doing via `kubectl`, useful
   while you're still building intuition for object relationships.
3. Deploy your Helm charts here, confirm `kubectl get pods,svc` shows both apps.
4. Important local-only wrinkle: minikube has its own container runtime, separate from your
   host Docker. This is *why* Phase 2 pushes to a registry instead of relying on images built
   locally — prove this to yourself by trying `kubectl run` with a locally-built-but-not-pushed
   image tag and watching it fail to pull.

**Checkpoint**: both apps running as pods in minikube, reachable via `kubectl port-forward`,
images pulled from GHCR (not loaded some other way) — this proves the full path
build→registry→cluster works.

**Read more**: minikube docs — https://minikube.sigs.k8s.io/docs/start/

---

## Phase 6 — GitOps concept + ArgoCD

**Concept**: GitOps means git is the single source of truth for *desired* cluster state, and a
controller (ArgoCD) continuously reconciles the live cluster to match it — the same
control-loop idea as a Deployment reconciling pods, just one level up. You never run `kubectl
apply` or `helm upgrade` by hand once this is wired up; you commit to git, and ArgoCD notices
and syncs. This is the "CD" that most CI/CD pipelines are actually missing.

**Try yourself**:
1. Install ArgoCD into your minikube cluster (official install manifest, dedicated namespace).
2. Access the UI (`kubectl port-forward svc/argocd-server -n argocd 8080:443`), log in with the
   initial admin secret.
3. Manually create an `Application` in the UI first (not YAML) pointing at your GitHub repo and
   `charts/backend` — this is the fastest way to see all the fields ArgoCD cares about before
   you commit to writing the YAML version.
4. Watch it sync. Then break the "GitOps rule" on purpose: `kubectl scale deployment backend
   --replicas=5` directly, and watch ArgoCD flag it as `OutOfSync` and revert it (if
   auto-sync + self-heal is on) — this is the concept "clicking" moment.
5. Once you've seen it work via the UI, export/write the equivalent `Application` YAML and
   commit *that* to git too (ArgoCD can even manage its own Application definitions this way —
   "app of apps" is this idea taken further, not needed yet).

**Checkpoint**: you changed something in `values.yaml`, pushed to `main`, and watched ArgoCD
(not you) apply it to the cluster within its sync interval.

**Read more**: ArgoCD's core concepts page — https://argo-cd.readthedocs.io/en/stable/core_concepts/

---

## Phase 7 — CI (GitHub Actions)

**Concept**: CI's job here is narrow and specific — build an image, push it, and record its tag
somewhere GitOps can see (i.e., commit the new tag into `values.yaml`). CI does **not** touch
the cluster directly; that boundary is the whole point of separating CI from CD in a GitOps
setup.

**Try yourself**:
1. Write a workflow triggered on `push` to `main` that just builds and pushes the backend image
   — get this working and verified in the GHCR UI before adding the second job.
2. Add the step that edits `charts/backend/values.yaml`'s `image.tag` and commits it back
   (`yq` for the YAML edit, then `git config user.email/name` + `commit` + `push` inside the
   Action — note this needs a token with write access to the repo, `GITHUB_TOKEN` with the
   right permissions block is usually enough).
3. Confirm this triggers ArgoCD (Phase 6) without you doing anything manual.
4. Repeat for the frontend.

**Checkpoint**: edit `frontend/src/App.tsx`, `git push`, and — untouched by you — watch the
change appear in the running pod a few minutes later. That's the full loop from the original
question: "can I manage this with ArgoCD locally" — yes, and now you've built and understood
every link in the chain instead of just running someone else's script.

**Read more**: GitHub Actions docs, "Building and testing" + "Publishing Docker images" guides —
https://docs.github.com/en/actions/publishing-packages/publishing-docker-images

---

## How to use this doc

Work top to bottom, but don't move to the next phase until the **checkpoint** of the current
one is genuinely true — not "the file exists" but "I ran the command and saw the expected
behavior." When you get stuck on something specific (an error message, a concept that isn't
clicking), bring me that specific thing rather than asking me to write the phase for you — that
keeps the learning yours.
