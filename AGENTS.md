# HuntLinq development requirements

HuntLinq is a free, mobile-first hunting group location-sharing app hosted on GitHub Pages. It uses Leaflet with free USGS aerial and topographic maps, Firebase authentication and live location sharing, and a name and shared group password for entry. Hunters can install it as a Progressive Web App on Android and iPhone. The existing app has worked on multiple phones.

- Keep the app free to operate within existing service limits.
- Prioritize simplicity, speed, reliability, and ease of use outdoors.
- Preserve existing working functionality, including the mobile installation and sign-in flows.
- Keep location sharing voluntary. Hunters choose when to start and stop sharing.
- Keep the group password and private hunting coordinates out of GitHub, including source, fixtures, screenshots, logs, issues, and commit history.
- Use synthetic coordinates and test data for functionality tests. Keep tests isolated from production location records.
- Test changes before recommending deployment. Consider Android, iPhone, and poor cellular coverage when assessing field behavior.
- Work on a separate development branch. Obtain the owner's explicit approval before pushing changes to main or deploying.
- Explain technical decisions, tradeoffs, and costs to the owner in plain English.
