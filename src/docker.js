const { Docker } = require("node-docker-api");

module.exports = async config => {

    const docker = new Docker({ socketPath: config.socket });
    const domain = config.domain;

    return {
        async createMapping() {
            let containers = await Promise.all((await docker.container.list()).map(c => c.status()));            
            
            return containers.map(c => {
                
                let hostname = c.data.Config.Labels["cz.drake.dockprox.host"] || c.data.Config.Hostname;
                
                let containerName = c.data.Name;
                if (containerName.startsWith("/")) {
                    containerName = containerName.substring(1);
                }
            
                if (hostname.length === 12 && hostname.match(/^[0-9a-f]+$/)) {
                    
                    hostname = containerName;
                    
                    let composeMatch = /^.+_(?<name>.*)_[0-9]+$/.exec(hostname);
                    if (composeMatch) {
                        hostname = composeMatch.groups.name;
                    }
                }

                if (hostname.indexOf(".") === -1) {
                    hostname = hostname + "." + (c.data.Config.Domainname || domain);
                }

                return {
                    front: {                        
                        host: hostname
                    },
                    back: {
                        host: containerName
                    }
                }
            });
        }
    }
}