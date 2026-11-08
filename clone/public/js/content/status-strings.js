// Text catalog defaults for public/js/views/status.js — the status page (CLONE_SPEC.md §35.10, §32.3). Incidents
// themselves are CMS entries staff publish (Admin › Status incidents); these are the labels around them. The object
// between the markers must stay strict JSON: the server reads it to build the catalog (server/cms/texts.js).
import { register } from '../i18n.js';

export const STRINGS = /* CONTENT_JSON_BEGIN */ {
  "status.page.title": "Parlance status",
  "status.page.doc_title": "Status · Parlance",
  "status.page.updated": "Updated {time}",
  "status.page.docs": "Developer docs",
  "status.overall.operational": "All systems operational",
  "status.overall.maintenance": "Scheduled maintenance in progress",
  "status.overall.degraded": "Some systems are degraded",
  "status.overall.outage": "Some systems are down",
  "status.component.operational": "Operational",
  "status.component.maintenance": "Maintenance",
  "status.component.degraded": "Degraded",
  "status.component.outage": "Outage",
  "status.component.disabled": "Not offered right now",
  "status.component.port": "Port {port}",
  "status.incidents.title": "Incidents",
  "status.incidents.empty": "No incidents in the last 90 days.",
  "status.incident.status.investigating": "Investigating",
  "status.incident.status.identified": "Identified",
  "status.incident.status.monitoring": "Monitoring",
  "status.incident.status.resolved": "Resolved",
  "status.incident.impact.maintenance": "Maintenance",
  "status.incident.impact.degraded": "Degraded performance",
  "status.incident.impact.outage": "Outage",
  "status.incident.started": "Started {time}",
  "status.incident.resolved": "Resolved {time}",
  "status.incident.affects": "Affects: {components}",
  "status.unavailable": "The status page is not available right now."
} /* CONTENT_JSON_END */;
export const META = /* CONTENT_META_BEGIN */ {} /* CONTENT_META_END */;
register(STRINGS, META);
