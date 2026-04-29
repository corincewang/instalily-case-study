-- CreateTable
CREATE TABLE `CatalogPart` (
    `id` VARCHAR(191) NOT NULL,
    `partNumber` VARCHAR(191) NOT NULL,
    `manufacturerPartNumber` VARCHAR(128) NULL,
    `applianceFamily` VARCHAR(64) NOT NULL DEFAULT 'refrigerator',
    `searchDocument` LONGTEXT NULL,
    `data` JSON NOT NULL,

    UNIQUE INDEX `CatalogPart_partNumber_key`(`partNumber`),
    INDEX `CatalogPart_manufacturerPartNumber_idx`(`manufacturerPartNumber`),
    INDEX `CatalogPart_applianceFamily_idx`(`applianceFamily`),
    FULLTEXT INDEX `CatalogPart_searchDocument_idx`(`searchDocument`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CatalogPartReplace` (
    `id` VARCHAR(191) NOT NULL,
    `oldNumberNormalized` VARCHAR(64) NOT NULL,
    `partId` VARCHAR(191) NOT NULL,

    INDEX `CatalogPartReplace_oldNumberNormalized_idx`(`oldNumberNormalized`),
    INDEX `CatalogPartReplace_partId_idx`(`partId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CatalogCompatibility` (
    `id` VARCHAR(191) NOT NULL,
    `partNumber` VARCHAR(32) NOT NULL,
    `modelNormalized` VARCHAR(64) NOT NULL,
    `data` JSON NOT NULL,

    INDEX `CatalogCompatibility_partNumber_idx`(`partNumber`),
    INDEX `CatalogCompatibility_modelNormalized_idx`(`modelNormalized`),
    INDEX `CatalogCompatibility_partNumber_modelNormalized_idx`(`partNumber`, `modelNormalized`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CatalogRepairGuide` (
    `id` VARCHAR(191) NOT NULL,
    `data` JSON NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `CatalogPartReplace` ADD CONSTRAINT `CatalogPartReplace_partId_fkey` FOREIGN KEY (`partId`) REFERENCES `CatalogPart`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
