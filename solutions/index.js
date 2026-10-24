let hoursSinceCareVisit = 0;
const CARE_HOME_LOCATION =  "care_home_id";

// check fastest travel time between two locations
function getTravelTime(startId, endId, roads) {
    if(startId === endId) {
        return 0;
    }

    const graph = {};
    for(const road of roads) {
        if(road.status === "closed") continue;

        const time = road.status === "restricted" ? road.hours * 1.5 : road.hours;

        // builds const graph for path calculation algorithm
        if(!graph[road.from_location_id]) graph[road.from_location_id] = [];
        if(!graph[road.to_location_id]) graph[road.to_location_id] = [];

        graph[road.from_location_id].push({to: road.to_location_id, cost: time});
        graph[road.to_location_id].push({to: road.from_location_id, cost: time});
    }

    const distances = {[startId]: 0};
    const unvisited = new Set(Object.keys(graph));
    if(!unvisited.has(startId)) return Infinity;

    while(unvisited.size > 0) {
        let current = null;
        for(const node of unvisited) {
            if(distances[node] !== undefined && (current === null || distances[node] < distances[current])) {
                current = node;
            }
        }
        if(current === null || current === endId) break;

        unvisited.delete(current);

        for(const neighbor of graph[current]) {
            const newDist = distances[current] + neighbor.cost;
            if(distances[neighbor.to] === undefined || newDist < distances[neighbor.to]) {
                distances[neighbor.to] = newDist;
            }
        }
    }

    return distances[endId] !== undefined ? distances[endId] : Infinity;
}

class EngineClient {    
    constructor(host = "127.0.0.1", port = 8600) {
        this.baseUrl = `http://${host}:${port}`;
    }

    async reset(scenarioName) {
        return this._request("POST", "/reset", {scenario: scenarioName});
    }
    
    async _request(method, path, payload = null) {
        const options = {
            method: method,
            headers: {"Content-Type": "application/json"}
        };

        if(payload) {
            options.body = JSON.stringify(payload);
        }

        try{
            const response = await fetch(this.baseUrl + path, options);
            const data = await response.json().catch(() => ({}));

            if(!response.ok || (data.ok === false)) {
                throw new Error(data.error || `Server Error: ${response.status}`);
            }

            return data;
        } catch(error) {
            console.error(`[API ERROR] ${method} ${path} failed:`, error.message);
            throw error;
        }
    }

    async state() {
        const res = await this._request("GET", "/state");
        return res.state;
    }

    async advance() {
        return this._request("POST", "/advance", {});
    }

    async applyAction(action) {
        if(action.type === "dispatch") {
            return this._request("POST", "/dispatch", { vehicle_id: action.vehicle_id, incident_id: action.incident_id });
        }

        if(action.type === "move") {
            return this._request("POST", "/move", { vehicle_id: action.vehicle_id, location_id: action.location_id });
        }

        if (action.type === "cancel") {
            return this._request("POST", "/cancel", { vehicle_id: action.vehicle_id });
        }
    }

    async report() {
        const res = await this._request("GET", "/report");
        return res.report;
    }
}

async function runLoop() {
    const client = new EngineClient();

    console.log("resetting the game server to hour 0....");
    await client.reset("30day");

    let isRunning = true;
    console.log("Starting the simulation loop...");

    while (isRunning) {
        const currentState = await client.state();

        if (currentState.clock >= currentState.horizon_hours) {
            console.log("Simulation reached the end time!");
            break;
        }

// decision logic
        const actionsToTake = [];

        const availableVehicles = currentState.vehicles.filter(car => car.status === "available");
        const activeIncidents = currentState.incidents.filter(inc => inc.status === "open" && inc.assigned_vehicle_id === null);

        // 1. THE VIP RULE (Smart Care Home Defense with Trade-offs)
        // ---------------------------------------------------------
        if(currentState.chronic && availableVehicles.length > 0) {
            const careHomeLocation = currentState.chronic.location_id;
            const timeUntilLoss = currentState.chronic.next_tick - currentState.clock;

            // Find the CLOSEST available vehicle to the Care Home
            let closestCar = null;
            let closestCarIndex = -1;
            let minTravelTime = Infinity;

            for (let i = 0; i < availableVehicles.length; i++) {
                const car = availableVehicles[i];
                const tTime = getTravelTime(car.location_id, careHomeLocation, currentState.roads);
                const arrivalHours = Math.ceil(tTime / car.speed);
               
                if (arrivalHours < minTravelTime) {
                    minTravelTime = arrivalHours;
                    closestCar = car;
                    closestCarIndex = i;
                }
            }

            const warningBuffer = Math.max(minTravelTime + 2, 5);

            if (timeUntilLoss <= warningBuffer && closestCar) {
               
                // --- NEW: THE SACRIFICE TRADE-OFF ---
                // The care home loses 2 people per missed window.
                // Let's check if this car could save significantly more people elsewhere.
                let maxAlternativeLives = 0;
               
                for (const emergency of activeIncidents) {
                    const travelHours = getTravelTime(closestCar.location_id, emergency.location_id, currentState.roads);
                    const arrivalHour = currentState.clock + Math.ceil(travelHours / closestCar.speed);
                   
                    // If we can reach the emergency in time, check how many people it saves
                    if (arrivalHour <= emergency.deadline && emergency.people_at_risk > maxAlternativeLives) {
                        maxAlternativeLives = emergency.people_at_risk;
                    }
                }

                // If the Care Home trip takes more than 4 hours AND we have a massive emergency (6+ people)
                // we intentionally sacrifice the 2 care home residents to save the bigger group.
                if (minTravelTime > 4 && maxAlternativeLives >= 6) {
                    console.log(`[Hour ${currentState.clock}] TRADE-OFF: Sacrificing Care Home (2 lives) so Car ${closestCar.id} can save ${maxAlternativeLives} lives!`);
                    // By NOT removing the car from availableVehicles, it falls into the main dispatcher
                    // below, which will automatically assign it to that massive emergency.
                } else {
                    // Standard Care Home Defense (Not worth sacrificing)
                    availableVehicles.splice(closestCarIndex, 1);

                    if (closestCar.location_id === careHomeLocation) {
                        // Find a valid road to bounce to
                        const adjacentRoad = currentState.roads.find(r =>
                            (r.from_location_id === careHomeLocation || r.to_location_id === careHomeLocation) &&
                            r.status !== "closed"
                        );
                        const bounceLocation = adjacentRoad.from_location_id === careHomeLocation ? adjacentRoad.to_location_id : adjacentRoad.from_location_id;

                        actionsToTake.push({
                            type: "move",
                            vehicle_id: closestCar.id,
                            location_id: bounceLocation
                        });
                        console.log(`[Hour ${currentState.clock}] VIP Move: Bouncing car ${closestCar.id} to ${bounceLocation}`);
                    } else {
                        actionsToTake.push({
                            type: "move",
                            vehicle_id: closestCar.id,
                            location_id: careHomeLocation
                        });
                        console.log(`[Hour ${currentState.clock}] VIP Move: Car ${closestCar.id} heading to Care Home`);
                    }
                }
            }
        }

        // ---------------------------------------------------------
        // 2. THE SMART DISPATCHER (Biggest Bang for Buck + Urgency)
        // ---------------------------------------------------------
       
        // Sort vehicles by speed (fastest first). As the guide notes, the fast ambulance
        // is critical. Letting it pick its target first prevents slow cars from stealing its optimal missions.
        availableVehicles.sort((a, b) => b.speed - a.speed);

        for(const car of availableVehicles) {
            let chosenEmergency = null;
            let chosenEmergencyIndex = -1;
            let bestScore = -1;

            for (let i = 0; i < activeIncidents.length; i++) {
                const emergency = activeIncidents[i];
                const travelHours = getTravelTime(car.location_id, emergency.location_id, currentState.roads);
                const arrivalHour = currentState.clock + Math.ceil(travelHours / car.speed);

                if(arrivalHour <= emergency.deadline) {
                    // Score = people saved / travel time. (Use 0.1 to avoid dividing by 0 if already there)
                    // We also add an urgency bonus for emergencies expiring soon, blending both strategies from the guide.
                    const hoursUntilDeadline = emergency.deadline - currentState.clock;
                    const urgencyBonus = 100 / (hoursUntilDeadline || 1);
                   
                    const score = (emergency.people_at_risk / (travelHours || 0.1)) + urgencyBonus;
                   
                    if(score > bestScore) {
                        bestScore = score;
                        chosenEmergency = emergency;
                        chosenEmergencyIndex = i;
                    }
                }
            }

            if(chosenEmergency !== null) {
                // Remove the chosen emergency so the next car doesn't try to go there
                activeIncidents.splice(chosenEmergencyIndex, 1);

                actionsToTake.push({
                    type: "dispatch",
                    vehicle_id: car.id,
                    incident_id: chosenEmergency.id
                });
               
                console.log(`[Hour ${currentState.clock}] dispatch: car ${car.id} to emergency ${chosenEmergency.id}`);
            }
        }

        for(const action of actionsToTake) {
            await client.applyAction(action);
        }

        console.log(`Hour ${currentState.clock} complete. Advancing...`);
        const advanceResult = await client.advance();

        if (advanceResult.clock === currentState.clock) {
            console.log("Error: Time did not advance. Stopping.");
            break;
        }
    }

    const finalReport = await client.report();
    console.log("\n---FINAL RESULTS--- ");
    console.log(`People Saved: ${finalReport.people_saved_total} / ${finalReport.people_at_risk_total}`)
}

runLoop();