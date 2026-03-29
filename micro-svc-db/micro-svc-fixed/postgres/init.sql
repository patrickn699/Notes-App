-- This script runs automatically when the Postgres container starts for the first time.
-- It creates the two separate databases for auth and notes services.
-- Each service only connects to its own database — good practice for isolation.

CREATE DATABASE authdb;
CREATE DATABASE notesdb;
