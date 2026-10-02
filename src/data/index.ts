import type { Route } from "../types";

export const routes: Route[] = [
	{
		id: "ktm-ring-road",
		name: "Kathmandu Ring Road",
		mode: "bus",
	},
	{
		id: "ratnapark-lalitpur",
		name: "Ratnapark to Lalitpur",
		mode: "microbus",
	},
	{
		id: "koteshwor-bhaktapur",
		name: "Koteshwor to Bhaktapur",
		mode: "tempo",
	},
];

export function getRouteById(routeId: string): Route | undefined {
	return routes.find((route) => route.id === routeId);
}

export function getRoutesByMode(mode: Route["mode"]): Route[] {
	return routes.filter((route) => route.mode === mode);
}

export function searchRoutes(query: string): Route[] {
	const normalizedQuery = query.trim().toLowerCase();

	if (!normalizedQuery) {
		return [];
	}

	return routes.filter((route) =>
		route.name.toLowerCase().includes(normalizedQuery),
	);
}
