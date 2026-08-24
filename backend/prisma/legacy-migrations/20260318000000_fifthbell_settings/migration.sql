-- CreateTable
CREATE TABLE "FifthBellSettings" (
    "id" INTEGER NOT NULL PRIMARY KEY,
    "showArticles" BOOLEAN NOT NULL DEFAULT true,
    "showWeather" BOOLEAN NOT NULL DEFAULT true,
    "showEarthquakes" BOOLEAN NOT NULL DEFAULT true,
    "showMarkets" BOOLEAN NOT NULL DEFAULT true,
    "showMarquee" BOOLEAN NOT NULL DEFAULT false,
    "showCallsignTake" BOOLEAN NOT NULL DEFAULT true,
    "weatherCitiesJson" TEXT NOT NULL DEFAULT '[]',
    "updatedAt" DATETIME NOT NULL
);
