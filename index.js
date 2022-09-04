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
    //   and our process's environment variables 
    //   into the context's `process.env`
    // - Yes, I recognize this is overwriting our current `process.env`, which is why a copy is made to be restored later.
    let envCopy = {...process.env};
    context.process.env = environment;
    Object.assign(process.env, environment);

    // Create the VM
    vm.createContext(context);
    // - DO Functions' return values determine the response, we build a small script here to pass this return value back to us.
    let scr = `let entry = require('${script}'); backContext.returned = entry.main(backContext.args);`;
    var start = process.hrtime(); // start timing
    // Execute the script in the VM
    vm.runInContext(scr, context, {
        lineOffset: 0,
        columnOffset: 0,
        displayErrors: true,
        timeout: 30000
    });
    // Wait for (potentially asynchronous) execution to finish.
    context.backContext.returned = await context.backContext.returned;
    var end = process.hrtime(start);  // end timing
    console.log(`Executed in: ${end[0]}s ${end[1]/1000000}ms`); // timing info
    // Write our original environment to `process.env`
    process.eenv = envCopy;
    // Return response
    return context.backContext;
}

module.exports.run = async function (port = 80, projectYMLFile = './project.yml', packagesDirectory = './packages') {
    console.log(`Setting up to serve functions at ${projectYMLFile} located at ${packagesDirectory} on port ${port}`);
    console.log(`Listening on :${port}\n\n`);

    // Using express as our web server.
    let express = require('express');
    let app = express();
    app.use(express.json());  // primarily handling JSON only for now.

    app.get('/_routes', (req, res, next) => {
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
        res.header('Content-Type', 'application/json');
        return res.send(JSON.stringify(routes, null, 4));
    });

    app.use((req, res, next) => {
        res.header("Access-Control-Allow-Origin", '*');
        next();
    });

    // Read project configurations
    var fsProject = fs.readFileSync(projectYMLFile);
    var config = yaml.load(fsProject);

    // Load packages and actions
    for (let package of config.packages) {
        for (let action of package.actions) {
            if (!action.runtime.includes("nodejs")) {
                // We only support nodejs runtimes here.
                console.log("Skipping action " + action.name + " since it is not a nodejs runtime.");
                continue;
            }
            let subdirectory = package.name + "/" + action.name;
            let actionLocation = packagesDirectory + "/" + subdirectory;
            let fsPackage = fs.readFileSync(actionLocation + "/package.json", "utf-8");
            let actionConfig = JSON.parse(fsPackage);
            let mainEntrypoint = actionConfig.main;
            let route = "/" + subdirectory;
            let entrypointScript = actionLocation + "/" + mainEntrypoint;
            let environment = {};
            Object.assign(environment, config.environment);
            //console.log(`Executing NPM install on ${actionLocation}`);
            await child_process.exec('npm install', {cwd: actionLocation});
            //console.log(`...done`);
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
                res.status(exec.body ? (exec.status ?? 500) : 204).send(JSON.stringify(exec.body, null, 4));
            });
        }
    }
    
    app.listen(port, () => {
        console.log("\n\nNow running!");
    });
};
