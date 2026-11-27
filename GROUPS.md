# HuntLinq groups: Firebase setup and moving the original crew

HuntLinq now lets anyone start their own private group and invite people with a link, QR code or 6-character code. The original single group with one shared password keeps working next to the new groups until you retire it.

## Database layout

| Path | What it holds | Who can read it |
| --- | --- | --- |
| `groups/<id>/info` | Group name, leader, current invite key and 3-day code | Members of that group |
| `groups/<id>/members/<uid>` | Each member's name and role (leader or member) | Members of that group |
| `groups/<id>/locations/<uid>` | Latest shared spot, same fields as before | Members of that group |
| `invites/<key>` | Group name, who started it, members' names, for the join preview | Anyone who knows the key (never listed) |
| `groups/<id>/pending/<uid>` | Requests to join while a leader approves new people | Group leaders, and the person asking |
| `groups/<id>/removed/<uid>` | Phones a leader removed, so the link can't let them back in | Group leaders |
| `groups/<id>/lock` | Optional group password, if a leader turns it on | Nobody (the server only compares it) |
| `groups/<id>/unlocked/<uid>` | The password each phone last entered, checked against `lock` | Nobody |
| `codes/<CODE>` | Which invite a 6-character code opens, and when it expires | Anyone who knows the code, until it expires (never listed) |
| `config`, `members`, `locations` | The original password group, unchanged | Unchanged |

The rules in `database.rules.json` keep each group private to its own members. `python3 _qa/rules.py <emulator jar>` checks that.

## Order of steps in the Firebase console

1. **Publish the new rules first.** In the Firebase console, open Realtime Database, then Rules. Paste the whole `database.rules.json` from the newest phase you are merging, then tap Publish. The original group keeps working, because its part of the rules is unchanged.
2. **Then merge the pull request.** If the app goes live before the rules, starting a group fails with a permission error. The original group is not affected.
3. **Stacked phases: one rules publish per merge.** Each phase's rules include the earlier phases', so publish phase 1's rules, merge phase 1, then publish phase 2's rules, merge phase 2. Publishing phase 2's rules while phase 1 is live is also safe.
4. **Nothing else changes in Firebase.** Anonymous sign-in stays on, there's no data to copy, and it still fits the free Spark plan.

## Moving the original crew

1. Open huntlinq.com, tap Start a group, and name it (for example "TJ's crew").
2. Tap Share invite link and send it in your group text. Each hunter taps it, types a name and joins. This phone is then remembered, so there's no password at each launch.
3. While people move over, "Have the original group password? Use it here" on the Start screen still opens the old group.
4. Once everyone has moved over, ask for the follow-up that removes the old password option. Then, in the console's Data tab, delete `config`, `members` and `locations` at the top level. Only latest spots live there, so no history is lost.
