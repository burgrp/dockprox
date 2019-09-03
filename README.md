# dockprox
HTTP/HTTPS proxy driven by Docker labels


build and push:
```
docker build -t burgrp/dockprox .
docker push burgrp/dockprox
```

test run:
```
docker run --rm --name dockprox -e DOMAIN=drake.cz -v /var/run/docker.sock:/var/run/docker.sock -p 80:80 --network dockprox_default burgrp/dockprox
```

Local NGINX compose for testing:
```
docker-compose up --remove-orphans
```

VS Code launch:
```

```