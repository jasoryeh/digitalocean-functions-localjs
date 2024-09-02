const yaml = require('js-yaml');
const fs = require('fs');
const vm = require('vm');
const child_process = require('child_process');

async function inVM(script, args, environment) {
    /**
     * The script's context, in other words: the objects accessible to the script.
     * varname: object
     */
    let context = {
        require: require,
        console: console,
        process: process,
        backContext: {
            args: args,
            returned: null
        }
    };

    // Merge the environment variables passed to this function, 
    //   and our process's environment variables into the context's `process.env`
    // - Yes, I recognize this is overwriting our current `process.env`, which is why a copy is made to be restored later.
    let envCopy = {...process.env};
    context.process.env = environment;
    Object.assign(process.env, environment);

    // Create the VM
    vm.createContext(context);
    // - DO Functions' return values determine the response, we build a small script here to pass this return value back to us.
    let scr = `let entry = require('${script}'); backContext.returned = entry.main(backContext.args);`;

    var start = process.hrtime(); // start timing
    vm.runInContext(scr, context, {
        lineOffset: 0,
        columnOffset: 0,
        displayErrors: true,
        timeout: 30000
    }); // Execute the script in the VM
    context.backContext.returned = await context.backContext.returned; // Wait for (potentially asynchronous) execution to finish.
    var end = process.hrtime(start);  // end timing

    console.log(`Executed in: ${end[0]}s ${end[1]/1000000}ms`); // timing info

    // Write our original environment to `process.env`
    process.env = envCopy;
    
    return context.backContext;
}

function getExpressRoutingInfo(app) {
    let routes = [];
    for (let layer of app._router.stack) {
        if (layer.route) {
            routes.push({path: layer.route.path, methods: layer.route.methods});
        } else if (layer.name == 'router') {
            for (let sl of layer.handle.stack) {
                if (sl && sl.route) {
                    routes.push({path: sl.route.path, methods: sl.route.methods});
                }
            }
        }
    }
    return routes;
}

function routers_routingInfo(app) {
    return function(req, res, next) {
        let routes = getExpressRoutingInfo(app);
        res.header('Content-Type', 'application/json');
        return res.send(JSON.stringify(routes, null, 4));
    }
}

function middleware_CORS(req, res, next) {
    res.header("Access-Control-Allow-Origin", '*');
    res.header("Access-Control-Allow-Methods", '*');
    res.header("Access-Control-Allow-Headers", '*');
    if (req.method.toUpperCase() == "OPTIONS") {
        return res.send(null).status(200);
    }
    next();
}

module.exports.run = async function (port = 80, projectYMLFile = './project.yml', packagesDirectory = './packages') {
    console.log(`Setting up to serve functions at ${projectYMLFile} located at ${packagesDirectory} on port ${port}`);

    // Using express as our web server.
    let express = require('express');
    let app = express();

    // middlewares and default routes
    app.use(express.json());  // primarily handling JSON only for now.
    app.use(middleware_CORS); // middleware for allowing CORS
    app.get('/_routes', routers_routingInfo(app)); // debug info for routing information

    // Read project configurations
    var projectYML = fs.readFileSync(projectYMLFile);
    var config = yaml.load(projectYML);

    // Load packages and actions
    for (let package of config.packages) {
        for (let action of package.actions) {
            if (!action.runtime.includes("nodejs")) {
                // We only support nodejs runtimes here.
                console.warn("Skipping action " + action.name + " since it is not a nodejs runtime.");
                continue;
            }

            let subdirectory = package.name + "/" + action.name;
            let actionLocation = packagesDirectory + "/" + subdirectory;
            let packageJSON = fs.readFileSync(actionLocation + "/package.json", "utf-8");
            let actionConfig = JSON.parse(packageJSON);
            let mainEntrypoint = actionConfig.main;
            let route = "/" + subdirectory;
            let entrypointScript = actionLocation + "/" + mainEntrypoint;

            // generate environment
            let environment = {};
            Object.assign(environment, config.environment);

            // subsitute envs in project.yml
            for (let key in environment) {
                for (let envKey in process.env) {
                    environment[key] = environment[key].replace(`\${${envKey}}`, process.env[envKey]);
                }
            }

            // install npm
            console.log(`Executing NPM install on ${actionLocation}`);
            await child_process.exec('npm install', {cwd: actionLocation});
            console.log(`...done`);

            console.log("Registering " + route + " to " + actionLocation);
            // Register a route to handle all routes '/package/action*'
            app.all(route + "*", async function (req, res, next) {
                let parseURL = new URL("https://localhost"  + req.url);
                let path = parseURL.pathname.replace("/" + subdirectory, "");
                let args = {};
                Object.assign(args, {
                    "__ow_method": req.method,
                    "__ow_headers": req.headers,
                    "__ow_path": path
                });
                Object.assign(args, req.query);
                Object.assign(args, req.body);
                
                let specificEnvironment = {};
                Object.assign(specificEnvironment, environment);
                Object.assign(specificEnvironment, action.environment);
                
                var start = process.hrtime();
                let runInVM = await inVM(entrypointScript, args, specificEnvironment);
                var end = process.hrtime(start);
                console.log(`Processed ${req.url} -> ${actionLocation} -> ${path} | ${end[0]}s ${end[1]/1000000}ms`);
                let exec = runInVM.returned;
                res.header("Content-Type",'application/json');
                if (!exec) {
                    res.status(500).send(JSON.stringify({"error": true, "message": "No response!"}, null, 4));
                } else {
                    for (let headerKey in exec.headers) {
                        console.log("Header: " + headerKey + " - " + exec.headers[headerKey]);
                        res.header(headerKey, exec.headers[headerKey]);
                    }
                    res.status(exec.body ? (exec.statusCode ?? 500) : 204)
                        .send(JSON.stringify(exec.body, null, 4));
                }
            });
        }
    }
    
    app.listen(port, () => {
        console.log(`\nListening on :${port}`);
        console.log("Now running!");
    });
};
