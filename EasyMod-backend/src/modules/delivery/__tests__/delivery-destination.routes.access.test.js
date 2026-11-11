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

    test.each(directoryPaths)('%s is available to authorized shop members without owner-only access', (path) => {
        const layer = router.stack.find((candidate) => candidate.route?.path === path
            && candidate.route.methods.get);

        expect(layer).toBeDefined();
        expect(layer.route.stack.map((routeLayer) => routeLayer.handle.name)).not.toContain('requireOwner');
    });
});
