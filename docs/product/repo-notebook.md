# Repo Notebook Product Definition

Repo Notebook is a local system tool for saving GitHub repositories into an alphabetical notebook. A user pastes a GitHub repository URL, the app fetches public repository metadata and README content, stores it locally, and groups the saved repositories by their repository name's first letter.

The primary user experience is a three-pane workspace:

- A live GitHub Top 10 ticker for discovering currently popular repositories and saving them immediately.
- A compact A-Z rail for jumping between letter groups.
- A searchable repository notebook list grouped alphabetically.
- A selected repository detail view inspired by a GitHub repository start page, with repository identity, About data, root files, locally saved README content, clone status, and actions.

The tool is intentionally an app surface, not a marketing page. The first screen must be the usable notebook.

## Core Capabilities

- Save a GitHub repository by pasting a URL such as `https://github.com/owner/repo`.
- Fetch and refresh public metadata plus README content through the GitHub REST API.
- Persist saved repositories in a project-local JSON store.
- Group repositories alphabetically from A-Z, using `#` for names that do not start with a letter.
- Sort and present notebook rows by repository name first, using owner only as secondary context.
- Show a compact live ticker with ten currently popular public GitHub repositories.
- Save a repository directly from the live ticker into the same alphabetical notebook flow.
- Keep ticker title clicks inside Repo Notebook; external GitHub navigation uses a separate explicit icon.
- Search saved repositories by owner, name, description, language, or topic.
- Show a GitHub-like detail page with statistics, About, file list, README content, and useful actions.
- Keep README content inside a bounded scrollable panel so long documentation remains available without taking over the whole app.
- Clone a saved repository from the detail view into a controlled local folder inside the app data directory.
- Open a cloned repository folder from the app.
- Detect common Node and Python project commands after cloning, then offer install, start, stop, and log controls from the repository detail page.

## Visual Direction

The app uses a dark GitHub-inspired workspace over a local neon GitHub wall background. Panels keep a strong dark overlay so repository metadata, README text, and runtime controls remain readable while the background gives the tool a recognizable identity.

## Clone Behavior

The browser cannot safely execute local shell commands by itself. Repo Notebook therefore uses a local Node server endpoint for cloning. The server validates the repository identity, builds a GitHub clone URL, and runs `git clone` with argument arrays instead of shell string interpolation.

Clones are written under `data/clones/<owner>/<repo>`. If the target directory already exists, the app reports that the repository has already been cloned rather than overwriting it. Clone status, local path, install status, and last start command are stored with the saved repository. Runtime logs are kept separately under `data/runs/`.

## Non-Goals

- Managing private GitHub authentication as a first-class feature.
- Replacing GitHub's full repository UI.
- Running arbitrary shell commands from user input.
- Cloning outside the app's controlled data directory.

### Kaartinstellingen en clusterfilters

In de kaartlegenda opent **Kaartinstellingen** de live bediening:

- **Aantrekking**: 0–0,100, standaard 0,035. **Afstoting**: 0–6000, standaard 1500. Een wijziging brengt de bestaande simulatie opnieuw in beweging. **Reset physics** herstelt deze twee standaardwaarden zonder selectie, filters of zoom te wijzigen.
- **Bolletjesgrootte**: vast, stars of aantal links (de bestaande standaard). De radius blijft tussen 6 en 15 kaartpixels; vaste grootte is 8. Het aantal links gebruikt de volledige graph, zodat filteren de grootte niet telkens verandert.
- **Kleurmodus**: mono, twee statuskleuren (**Te proberen** versus **Overige statussen**, inclusief geen status), automatische clusterkleuren of handmatig per cluster. **Reset kleuren** herstelt de automatische kleuren en wist aangepaste kleuren.
- Het **vinkje** naast een cluster verbergt/toont de nodes en alle bijbehorende verbindingen. Ook clusters met één node zijn beschikbaar. Klikken op de **clusternaam** behoudt het bestaande uitlichten. **Alle clusters tonen** herstelt alle filters.

Physics, grootte en kleuren worden lokaal in de browser bewaard, ook na herladen of wisselen naar de lijst. Als opslag niet beschikbaar is, blijven de instellingen tijdens de gemounte kaart werken. Selectie, zoom en clusterfilters zijn tijdelijk; kleurwijzigingen resetten ze niet. Een verborgen geselecteerde node krijgt zijn informatiekaart terug wanneer zijn cluster opnieuw wordt getoond. Handmatige kleuren volgen de clusterleden; een opnieuw berekend cluster met andere leden krijgt de standaardkleur.

Validatie: `node --test test/graph-settings.test.js` controleert herhaald filteren/herstellen zonder bronmutatie, begrensde groottes, kleurmodi, clusterhernummering en ongeldige opgeslagen instellingen. `npm run build` controleert de productiebuild.
