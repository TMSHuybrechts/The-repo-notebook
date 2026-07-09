export const letters = ["#", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];

export const repoLetter = (repo) => (/^[A-Z]/i.test(repo.name) ? repo.name[0].toUpperCase() : "#");

export const shortNumber = (value = 0) =>
  Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);

export const shortDate = (date) =>
  date
    ? Intl.DateTimeFormat("nl-BE", {
        day: "2-digit",
        month: "short",
        year: "numeric"
      }).format(new Date(date))
    : "Onbekend";

export const fileSize = (size = 0) => {
  if (!size) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
};

export const languageColor = (language) =>
  ({
    JavaScript: "#f1e05a",
    TypeScript: "#3178c6",
    Python: "#3572a5",
    Go: "#00add8",
    Rust: "#dea584",
    PHP: "#4f5d95",
    Java: "#b07219",
    HTML: "#e34c26",
    CSS: "#563d7c",
    Vue: "#41b883",
    Shell: "#89e051"
  })[language] || "#54aeff";
