# k8s-notes-app 📝

A minimal 3-microservice web app built for **Kubernetes practice**.

```
┌─────────────────────────────────────────────────────────┐
│                        Browser                          │
└───────────────────────┬─────────────────────────────────┘
                        │  HTTP
                        ▼
              ┌─────────────────┐
              │    frontend     │  Nginx (port 80)
              │  (static HTML)  │  proxies /api/* to backends
              └────────┬────────┘
                       │ internal cluster DNS
          ┌────────────┴────────────┐
          ▼                         ▼
 ┌────────────────┐       ┌─────────────────┐
 │  auth-service  │◄──────│  notes-service  │
 │  (port 3001)   │verify │  (port 3002)    │
 │                │ JWT   │                 │
 └────────────────┘       └─────────────────┘
```

## Services

| Service | Port | Responsibility |
|---|---|---|
| `auth-service` | 3001 | Register, login, JWT issue & verify |
| `notes-service` | 3002 | CRUD notes, validates JWT via auth-service |
| `frontend` | 80 | Nginx serving static HTML + reverse proxy |

---

## Phase 1 — Run with Docker Compose (quickest start)

```bash
cd k8s-notes-app

# Build and start all three services
docker compose up --build

# Open browser
open http://localhost:8080
```

Test the APIs directly:
```bash
# Register
curl -X POST http://localhost:3001/register \
  -H "Content-Type: application/json" \
  -d '{"username":"praths","password":"secret123"}'

# Login
TOKEN=$(curl -s -X POST http://localhost:3001/login \
  -H "Content-Type: application/json" \
  -d '{"username":"praths","password":"secret123"}' | jq -r .token)

# Create a note
curl -X POST http://localhost:3002/notes \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"title":"My First Note","content":"Hello Kubernetes!"}'

# List notes
curl http://localhost:3002/notes -H "Authorization: Bearer $TOKEN"
```

---

## Phase 2 — Local Kubernetes (minikube or kind)

### Option A — minikube

```bash
# Start cluster
minikube start

# Point your Docker CLI to minikube's Docker daemon
eval $(minikube docker-env)

# Build images inside minikube (so imagePullPolicy: Never works)
docker build -t k8s-notes/auth-service:latest  ./auth-service
docker build -t k8s-notes/notes-service:latest ./notes-service
docker build -t k8s-notes/frontend:latest      ./frontend

# Apply all manifests
kubectl apply -f k8s/

# Watch pods come up
kubectl get pods -w

# Get the frontend URL
minikube service frontend --url
```

### Option B — kind

```bash
kind create cluster --name notes-cluster

# Build images locally
docker build -t k8s-notes/auth-service:latest  ./auth-service
docker build -t k8s-notes/notes-service:latest ./notes-service
docker build -t k8s-notes/frontend:latest      ./frontend

# Load images into kind (kind can't use local Docker daemon directly)
kind load docker-image k8s-notes/auth-service:latest  --name notes-cluster
kind load docker-image k8s-notes/notes-service:latest --name notes-cluster
kind load docker-image k8s-notes/frontend:latest      --name notes-cluster

# Apply manifests
kubectl apply -f k8s/

# Port-forward to access the frontend
kubectl port-forward svc/frontend 8080:80
# Then open http://localhost:8080
```

---

## Useful kubectl commands to practice

```bash
# See all resources
kubectl get all

# Describe a pod (great for debugging)
kubectl describe pod <pod-name>

# View logs
kubectl logs -l app=auth-service --tail=50
kubectl logs -l app=notes-service --tail=50 -f   # follow

# Scale a deployment
kubectl scale deployment notes-service --replicas=3

# Rolling restart (simulate a redeploy)
kubectl rollout restart deployment/auth-service

# Watch rollout status
kubectl rollout status deployment/notes-service

# Exec into a pod
kubectl exec -it <pod-name> -- sh

# Delete and reapply
kubectl delete -f k8s/
kubectl apply -f k8s/
```

---

## Phase 3 — Azure Kubernetes Service (AKS)

```bash
# 1. Push images to Azure Container Registry
az acr build --registry <your-acr> --image auth-service:v1  ./auth-service
az acr build --registry <your-acr> --image notes-service:v1 ./notes-service
az acr build --registry <your-acr> --image frontend:v1      ./frontend

# 2. Update image references in k8s/*.yaml:
#    image: <your-acr>.azurecr.io/auth-service:v1
#    imagePullPolicy: Always

# 3. Create AKS cluster and attach ACR
az aks create -g <rg> -n notes-cluster --attach-acr <your-acr>
az aks get-credentials -g <rg> -n notes-cluster

# 4. Apply manifests (same files!)
kubectl apply -f k8s/

# 5. For Ingress on AKS, update 05-ingress.yaml with your domain
#    and install the nginx ingress controller via helm
```

---

## Key Kubernetes concepts demonstrated

- **Deployment** — desired state, rolling updates, replica sets
- **Service (ClusterIP)** — internal DNS-based service discovery between pods
- **Service (NodePort)** — exposes frontend outside the cluster locally
- **ConfigMap** — externalise config (AUTH_SERVICE_URL)
- **Secret** — manage sensitive values (JWT_SECRET)
- **Health probes** — readiness & liveness for zero-downtime deploys
- **Resource requests/limits** — CPU and memory constraints
- **Ingress** — single entry point with path-based routing (optional)
- **imagePullPolicy: Never** — use local images without a registry (local dev)
