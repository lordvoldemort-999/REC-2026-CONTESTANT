# REC 2026 DISPATCH PLANNER
### Solution by Abraham Omoregie AND David Tandia James-Nwokocha

## Installation Guide
 
- Ensure your machine has python 3.10+ installed.
- Run ``` git clone https://github.com/lordvoldemort-999/REC-2026-CONTESTANT.git ``` to get all files. I recommend doing it inside a separate well named folder.
- Navigate into the solutions folder using ``` cd REC-2026-CONTESTANT/solutions ```
- Run ` npm i ` to install dependencies.
- Navigate back into the main folder and in a new terminal, run ``` python -m engine.server --scenario 7day --port 8600 ``` to start the engine.
- Open a new terminal. In here is where you will run ``` node index.js ``` to get our planner working.
- If you want to run our simulation for a different number of days, open ` index.js ` and change the argument in the function call on **line 133** to the name of your .json file. For example to run our 90day simulation change it to **90day**.