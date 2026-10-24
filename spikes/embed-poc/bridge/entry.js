import { workbookDataToXlsx } from '@casualoffice/sheets/xlsx';
window.__toXlsx = async (snapshot) => { const blob = await workbookDataToXlsx(snapshot); return await blob.arrayBuffer(); };
