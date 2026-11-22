# How the daily task schedule works

This explains how the daily task lists in `daily-schedule.json` were worked out, why a modulo is involved, and how to keep them correct in future years.

## The problem

The game's original schedule (`Schedule.asset`) has **332 entries, one per consecutive day from 2018-03-06 to 2019-01-31**. Each entry points at that day's 4 tasks, plus the two that are on every day (`ClothingCatalogSubmission` and `TaskCompletion_5`).

That range ended years ago, but the server and client still need a list for today. The real client schedule for later dates was not in any file we had, so the list for a date in 2026 had to be inferred.

## The guess: the client loops the 332 days

If a client runs out of schedule, the simplest thing it can do is start again from the first day. Counting days since the start and taking the remainder after dividing by 332 does exactly that:

```
position = (days since 2018-03-06) % 332
list     = the schedule entry for the day at that position
```

### Worked example: 2026-11-22

1. Days from 2018-03-06 to 2026-11-22 = **3183**
2. 3183 / 332 = 9 full loops (9 x 332 = 2988), remainder **195**
3. Position 195 is 195 days after 2018-03-06, which is **2018-09-17**
4. The original schedule for `09-17` is `BeachMarketPurchase`, `BeachStageToWater`, `TownLapStatue`, `BeachSharkScare5` (+ the two fixed tasks)

That is the list the client showed on 2026-11-22.

## How the guess was found and checked

| Date | What happened | Loop position |
|---|---|---|
| 2026-11-21 | Claim for `DivingThroneRoom` was refused: it wasn't on the calendar (`MM-DD`) list for 11-21 | 09-16, whose list contains `DivingThroneRoom` |
| 2026-11-22 | Four tasks from the loop list all worked in the client | 09-17 |

One matching task could have been luck, since `DivingThroneRoom` appears on about 20 dates. Four matching tasks on the next day is very unlikely to be luck, so the loop was kept.

## Why a fixed MM-DD table stops working

A year has 365 days and the loop is 332 days, so on every 1 January the position jumps forward by **365 - 332 = 33 days** (34 after a leap year).

| Date | Loop position |
|---|---|
| 2026-01-01 | 202 |
| 2027-01-01 | 235 |
| 2028-01-01 | 268 |
| 2029-01-01 | 302 |

A table keyed by `MM-DD` built for 2026 therefore matches the loop on only 1 of 365 days in 2027 and 0 of 365 in 2028. That is why 2027 has its own exact-date entries.

## How the files are laid out

- **`MM-DD` keys (366 of them):** the 2026 schedule, each calendar date given the list at its loop position for 2026. Your hand fix for `11-21` is included (`TownEmoteStar`, `DivingThroneRoom`, `ChairliftRide`, `TownDisneyVisit`).
- **`YYYY-MM-DD` keys (all of 2027):** the same loop applied to each 2027 date.
- **Lookup (in `dailySchedule.ts`):** an exact date entry wins, otherwise the `MM-DD` entry is used.

## What is verified and what is a guess

Verified:
- The loop matched the client on 2026-11-21 (for `DivingThroneRoom`) and 2026-11-22 (all four tasks).

Not verified:
- **Every other date.** They follow from the same rule but have not been checked against the client.
- **Some tasks are missing from the data.** `TownDisneyVisit` was on the client's list for 2026-11-21 but doesn't exist anywhere in the 332-day schedule, so the real client schedule has entries we don't have. A few days will have a task that differs from the client's.
- **2028 onward.** Without exact-date entries the service falls back to the 2026 `MM-DD` table, which is wrong for 2028.

## Adding another year

Keep a copy of the **original** 332-day file (the one keyed by `MM-DD` for 2018-03-06 to 2019-01-31) as `daily-schedule.original.json`, then generate the year:

```python
import json, datetime as dt

orig = json.load(open("daily-schedule.original.json"))["days"]   # 332-day schedule
start = dt.date(2018, 3, 6)

def loop(d):
    return orig[(start + dt.timedelta(days=(d - start).days % 332)).strftime("%m-%d")]

year = 2028
d = dt.date(year, 1, 1)
new = {}
while d.year == year:
    new[d.isoformat()] = loop(d)
    d += dt.timedelta(days=1)
# merge `new` into the "days" object of daily-schedule.json
```

## Fixing a day that's wrong

If a claim is refused with `not in today's list` (or `not complete today`), the client's list for that date differs from the guess. Add or edit that exact date, either in the JSON or from the admin panel (`setDailyDay("2027-03-01", [...])`). Exact-date entries always win over the loop.

## Things that can make edits seem to do nothing

- A schedule saved from the admin panel is stored in the settings table (`daily_schedule`) and **overrides the JSON file**. Delete that row to use the file again.
- The server switches lists at **00:00 UTC**, which is 7 PM Eastern Standard Time.
- The game server caches the list for up to 5 minutes, so a change can take that long to be counted.
