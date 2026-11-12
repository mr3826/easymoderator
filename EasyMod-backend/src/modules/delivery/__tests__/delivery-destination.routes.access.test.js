'use strict';

const router = require('../delivery.routes');

const directoryPaths = [
    '/:provider/cities',
    '/:provider/cities/:cityId/zones',
    '/:provider/zones/:zoneId/areas',
    '/:provider/areas',
];

describe('courier destination directory route access', () => {
    test('keeps directory reads behind authentication and shop membership', () => {
        const globalMiddleware = router.stack
            .filter((layer) => !layer.route)
            .map((layer) => layer.handle.name);

        expect(globalMiddleware).toContain('authenticate');
        expect(globalMiddleware).toContain('verifyShopAccess');
    });

    test('registers authentication and shop membership before the directory routes', () => {
        // A future refactor that moved router.use(authenticate/verifyShopAccess)
        // below these routes would leave the presence assertions above green while
        // the routes became unauthenticated. Pin the ordering too (Security P2-1).
        const globalIndex = (name) => router.stack.findIndex((layer) => !layer.route && layer.handle.name === name);
        const authIndex = globalIndex('authenticate');
        const shopIndex = globalIndex('verifyShopAccess');
        expect(authIndex).toBeGreaterThanOrEqual(0);
        expect(shopIndex).toBeGreaterThanOrEqual(0);
        for (const path of directoryPaths) {
            const routeIndex = router.stack.findIndex((layer) => layer.route?.path === path && layer.route.methods.get);
            expect(routeIndex).toBeGreaterThan(authIndex);
            expect(routeIndex).toBeGreaterThan(shopIndex);
        }
    });

    test.each(directoryPaths)('%s is available to authorized shop members without owner-only access', (path) => {
        const layer = router.stack.find((candidate) => candidate.route?.path === path
            && candidate.route.methods.get);

        expect(layer).toBeDefined();
        expect(layer.route.stack.map((routeLayer) => routeLayer.handle.name)).not.toContain('requireOwner');
    });
});
