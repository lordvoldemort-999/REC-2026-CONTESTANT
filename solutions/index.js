const express = require('express');
const delay = ms => new Promise(res => setTimeout(res, ms));

let hoursSinceCareVisit = 0;
// Global variable to remember if a car is currently doing the out-and-back bounce
let bouncingCarId = null;

// A mini GPS to find the fastest travel time between two locations
function getTravelTime(startId, endId, roads) {
    if(startId === endId) return 0;

    const graph = {};
    for(const road of roads) {
        if(road.status === "closed") continue; // Closed roads are impassable

        // Restricted roads take 1.5x longer
        const time = road.status === "restricted" ? road.hours * 1.5 : road.hours;

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

        try {
            const response = await fetch(this.baseUrl + path, options);
            const data = await response.json().catch(() => ({}));

            if(!response.ok || (data.ok === false)) {
                throw new Error(data.error || `Server Error: ${response.status}`);
            }

            return data;
        } catch(error) {

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

// live dashboard server
const app = express();
let liveState = null;

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/dashboard.html');
});

app.get('/api/live', (req, res) => {
    res.json(liveState);
});

app.listen(3000, () => {
    console.log("Live Dashboard running at http://localhost:3000");
})

async function runLoop() {
    const client = new EngineClient();

    console.log("Resetting the game server to hour 0....");
    await client.reset("7day");

    let isRunning = true;
    console.log("Starting the simulation loop...");

    while (isRunning) {
        const currentState = await client.state();

        if (currentState.clock >= currentState.horizon_hours) {
            console.log("Simulation reached the end time!");
            break;
        }

        const actionsToTake = [];
        const availableVehicles = currentState.vehicles.filter(car => car.status === "available");
        const activeIncidents = currentState.incidents.filter(inc => inc.status === "open" && inc.assigned_vehicle_id === null);

        // Care-home operation logic
        const chronic = currentState.chronic;
        if (chronic && availableVehicles.length > 0) {
            const careHomeLoc = chronic.location_id;
           
            // Calculate if the care home has already been visited in this 24-hour cycle
            const windowStart = chronic.next_tick - chronic.interval_hours;
            const isSatisfied = chronic.last_visit > windowStart;
           
            // Check if any car is actively driving to the care home right now
            const isCarEnRoute = currentState.vehicles.some(v => v.mission && v.mission.target === careHomeLoc);
           
            // Check if a car is currently doing the out-and-back bounce maneuver
            const isBouncing = currentState.vehicles.some(v => v.id === bouncingCarId && v.status !== "available");
            if (!isBouncing) bouncingCarId = null; // Clear the memory if they finished bouncing

            // Only act if the home needs a visit, nobody is heading there, and nobody is bouncing
            if (!isSatisfied && !isCarEnRoute && !isBouncing) {
                const timeUntilLoss = chronic.next_tick - currentState.clock;

                // 16-hour warning buffer gives any car plenty of time to cross the map
                if (timeUntilLoss <= 16) {
                    let closestCar = null;
                    let closestCarIndex = -1;
                    let minTravelTime = Infinity;

                    for (let i = 0; i < availableVehicles.length; i++) {
                        const car = availableVehicles[i];
                        const tTime = getTravelTime(car.location_id, careHomeLoc, currentState.roads);
                        const arrivalHours = Math.ceil(tTime / car.speed);
                       
                        if (arrivalHours < minTravelTime) {
                            minTravelTime = arrivalHours;
                            closestCar = car;
                            closestCarIndex = i;
                        }
                    }

                    if (closestCar) {
                        availableVehicles.splice(closestCarIndex, 1);

                        if (closestCar.location_id === careHomeLoc) {
                            // Find the fastest adjacent road to bounce to
                            let bestBounce = "LOC-1";
                            let bestBounceTime = Infinity;
                            for (const r of currentState.roads) {
                                if (r.status !== "closed" && (r.from_location_id === careHomeLoc || r.to_location_id === careHomeLoc)) {
                                    const candidate = r.from_location_id === careHomeLoc ? r.to_location_id : r.from_location_id;
                                    const tTime = getTravelTime(careHomeLoc, candidate, currentState.roads);
                                    if (tTime < bestBounceTime) {
                                        bestBounceTime = tTime;
                                        bestBounce = candidate;
                                    }
                                }
                            }
                           
                            actionsToTake.push({ type: "move", vehicle_id: closestCar.id, location_id: bestBounce });
                            bouncingCarId = closestCar.id; // Remember this car is bouncing!
                            console.log(`[Hour ${currentState.clock}] VIP Move: Bouncing car ${closestCar.id} away to ${bestBounce}`);
                        } else {
                            actionsToTake.push({ type: "move", vehicle_id: closestCar.id, location_id: careHomeLoc });
                            console.log(`[Hour ${currentState.clock}] VIP Move: Car ${closestCar.id} heading to Care Home`);
                        }
                    }
                }
            }
        }

        // Dispatcher decision logic
        const allPossibleMissions = [];

        // Score every combination of cars and emergencies
        for (const car of availableVehicles) {
            for (const emergency of activeIncidents) {
                const travelHours = getTravelTime(car.location_id, emergency.location_id, currentState.roads);
               
                // Formula: travel time divided by speed multiplier, rounded up
                const effortHours = Math.ceil(travelHours / car.speed);
                const arrivalHour = currentState.clock + effortHours;

                // Feasibility Check: Only consider if we can arrive on or before the deadline
                if (arrivalHour <= emergency.deadline) {
                    // Score = Lives saved per hour of travel (using Math.max to prevent divide-by-zero)
                    const efficiencyScore = emergency.people_at_risk / Math.max(effortHours, 1);
                   
                    allPossibleMissions.push({
                        carId: car.id,
                        emergencyId: emergency.id,
                        score: efficiencyScore
                    });
                }
            }
        }

        // Sort by highest score descending
        allPossibleMissions.sort((a, b) => b.score - a.score);

        const assignedCars = new Set();
        const assignedEmergencies = new Set();

        // Lock in the highest-scoring pairs
        for (const mission of allPossibleMissions) {
            if (!assignedCars.has(mission.carId) && !assignedEmergencies.has(mission.emergencyId)) {
                actionsToTake.push({
                    type: "dispatch",
                    vehicle_id: mission.carId,
                    incident_id: mission.emergencyId
                });
               
                assignedCars.add(mission.carId);
                assignedEmergencies.add(mission.emergencyId);
                console.log(`[Hour ${currentState.clock}] DISPATCH: Car ${mission.carId} to Emergency ${mission.emergencyId} (Score: ${mission.score.toFixed(2)})`);
            }
        }

        // Execution
        for(const action of actionsToTake) {
            try {
                await client.applyAction(action);
            } catch (err) {
                // If a dispatch fails (e.g. road just closed), catch it gracefully so the code doesn't crash!
                console.log(`[Hour ${currentState.clock}] Action rejected by server: ${err.message}`);
            }
        }

        // For dashboard
        liveState = currentState;
        await delay(500);                   // To allow judges to observe decision making process

        const advanceResult = await client.advance();
        if (advanceResult.clock === currentState.clock) {
            console.log("Error: Time did not advance. Stopping.");
            break;
        }
    }

    const finalReport = await client.report();
    console.log("\n---FINAL RESULTS--- ");
    console.log(`People Saved: ${finalReport.people_saved_total} / ${finalReport.people_at_risk_total}`);
}

runLoop();